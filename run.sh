#!/bin/sh
# tdl-web 本地开发启动脚本（Linux / 本机沙箱适配版）
# 用法：sh run.sh {start|stop|restart|status|logs}
#
# 说明：本机 npm 被环境变量 NPM_CONFIG_GLOBAL=true 强制全局安装，
#       会导致 gui/node_modules 装不上，故此处显式覆盖为局部安装。

DIR=$(cd "$(dirname "$0")" && pwd)
GUI="$DIR/gui"
LOG=/tmp/tdlweb.log
PORT=${TDL_GUI_PORT:-8560}
export NPM_CONFIG_GLOBAL=false

pidof_server() {
  pgrep -f "node server.js" 2>/dev/null | head -1
}

case "$1" in
  start)
    if [ -n "$(pidof_server)" ]; then
      echo "已在运行，进程号 $(pidof_server)"
      exit 0
    fi
    cd "$GUI" || exit 1
    nohup node server.js > "$LOG" 2>&1 < /dev/null &
    sleep 3
    if [ -n "$(pidof_server)" ]; then
      echo "已启动，进程号 $(pidof_server)"
      echo "访问地址：http://127.0.0.1:$PORT"
    else
      echo "启动失败，日志："
      tail -20 "$LOG"
      exit 1
    fi
    ;;
  stop)
    pkill -f "node server.js" 2>/dev/null && echo "已停止" || echo "未在运行"
    ;;
  restart)
    pkill -f "node server.js" 2>/dev/null
    sleep 2
    cd "$GUI" || exit 1
    nohup node server.js > "$LOG" 2>&1 < /dev/null &
    sleep 3
    echo "已重启，进程号 $(pidof_server)"
    ;;
  status)
    P=$(pidof_server)
    if [ -n "$P" ]; then
      echo "运行中，进程号 $P"
      curl -s -o /dev/null -w "本机访问状态：%{http_code}\n" "http://127.0.0.1:$PORT/"
    else
      echo "未在运行"
    fi
    ;;
  logs)
    tail -30 "$LOG"
    ;;
  *)
    echo "用法：sh run.sh {start|stop|restart|status|logs}"
    ;;
esac
