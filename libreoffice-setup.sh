#!/bin/sh
# LibreOffice 恢复脚本 —— 让 Office 在线预览在容器/Pod 重建后依然可用
#
# 背景：LibreOffice 是用 apt 装在**容器镜像层**上的（overlay，易失）。
# Pod 一旦重建就没了，Office 预览会退化成「下载后本地查看」。
# 所以需要一个幂等的恢复脚本，由 boot-hook 在每次启动时跑。
#
# 设计：
#   1. 幂等 —— 已装就直接返回，不重复下载/安装。
#   2. 快速探测 —— 用 soffice --version 而不是只查文件存在，
#      避免「文件在但动态库缺」这种半残状态被误判为已装。
#   3. 失败不阻塞 —— 装不上只是 Office 预览不可用，服务本身照常跑，
#      所以任何失败都只是记日志退出，绝不 exit 非 0 拖垮 supervisord。
#   4. 后台执行 —— 装一次约 1-2 分钟，boot-hook 不能干等，
#      否则 Web 服务会被拖到装完才起来。所以本脚本支持 `detach` 模式。

BASE="/run/csi/mount-root/nas/4079184d856ecc166ed19d4887083405/workspaces/default/tdl-web"
LOGS="$BASE/logs"
MARK="$LOGS/.libreoffice-ready"
LOCK="$LOGS/.libreoffice-installing"

log() { echo "[lo-setup $(date '+%F %T')] $*"; }

# 已经装好过（且验证可用）→ 直接返回。
# 注意：这段快路径只对 install/detach 生效 —— status 必须走到下面的 case
# 去打印人可读的状态，否则它会被这里的 exit 0 直接吞掉、什么都不输出。
case "$1" in
  status) ;;   # 交给文件末尾的 status 分支
  *)
    if [ -f "$MARK" ] && command -v soffice >/dev/null 2>&1; then
      # 再确认一次不是半残（标记存在但二进制坏了的情况）
      if timeout 60 soffice --version >/dev/null 2>&1; then
        exit 0
      fi
      rm -f "$MARK"
    fi

    # 正在装 → 不重复启动第二个 apt
    if [ -f "$LOCK" ]; then
      log "已有安装在进行中，跳过"
      exit 0
    fi
    ;;
esac

do_install() {
  mkdir -p "$LOGS"
  # shell 的 noclobber 语义：用 set -C 冲突时失败，保证只有一个实例拿到锁
  if ! (set -C; : > "$LOCK") 2>/dev/null; then
    log "抢锁失败，另一个实例在装，退出"
    return 0
  fi
  trap 'rm -f "$LOCK"' EXIT INT TERM

  if command -v soffice >/dev/null 2>&1 && timeout 60 soffice --version >/dev/null 2>&1; then
    log "已可用，跳过安装"
  else
    log "开始安装 LibreOffice（Writer/Calc/Impress 核心三件套）"
    export DEBIAN_FRONTEND=noninteractive
    if ! apt-get update -qq; then
      log "apt-get update 失败（可能无网络），Office 预览暂不可用；服务不受影响"
      return 0
    fi
    if ! apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress; then
      log "安装失败，Office 预览暂不可用；服务不受影响"
      return 0
    fi
  fi

  # 装完做一次真实转换自检，通过才打标记
  TMP=$(mktemp -d 2>/dev/null) || TMP="/tmp/lo-selfcheck-$$"
  mkdir -p "$TMP"
  if timeout 180 soffice --headless --norestore --invisible \
      -env:UserInstallation=file://"$TMP/profile" \
      --version >/dev/null 2>&1; then
    touch "$MARK"
    log "LibreOffice 安装并自检通过，Office 在线预览已启用"
  else
    log "安装完成但自检失败，不打标记（下次启动会重试）"
  fi
  rm -rf "$TMP"
}

case "$1" in
  detach)
    # 后台跑，不拖住 boot-hook
    nohup sh "$0" install >/dev/null 2>&1 &
    ;;
  install|"")
    do_install
    ;;
  status)
    if [ -f "$MARK" ] && command -v soffice >/dev/null 2>&1; then
      echo "就绪：$(soffice --version 2>/dev/null | head -1)"
    else
      echo "未就绪（Office 在线预览不可用，可执行 $0 install）"
    fi
    ;;
  *)
    echo "用法: $0 {install|detach|status}"
    ;;
esac
