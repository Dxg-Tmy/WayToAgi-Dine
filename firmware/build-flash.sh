#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# build-flash.sh — 顺点·无障碍点餐盒 (DFRobot Beetle RP2350) 一键编译 / 烧录 / 验证
# ---------------------------------------------------------------------------
# 用法:
#   bash firmware/build-flash.sh            # 全流程：编译 + 烧录 + 验证
#   bash firmware/build-flash.sh --build    # 只编译
#   bash firmware/build-flash.sh --flash    # 只烧录（用已编译的 uf2）
#   bash firmware/build-flash.sh --verify   # 只验证
#
# 环境变量:
#   DINE_PYTHON  指定带 pyserial 的 python 解释器（必需）
#   DINE_ARDUINO_CLI  指定 arduino-cli（默认用 tools/arduino-cli.exe）
#
# 烧录原理：RP2350 需要进入 BOOTSEL（USB 大容量存储模式）
#   本脚本会自动完成：检测到板子正在运行旧固件时，
#   用「1200 波特触碰」触发 Arduino 核心软重启进 BOOTSEL，再由 picotool 烧录。
#   全程无需手动按板子上的 BOOTSEL 键。
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

ARDUINO_CLI="${DINE_ARDUINO_CLI:-$ROOT/tools/arduino-cli.exe}"
CONFIG="$ROOT/tools/arduino-cli.yaml"
SRC_DIR="$HERE/mcd_order_box"
BUILD_DIR="$HERE/build"
UF2="$BUILD_DIR/mcd_order_box.ino.uf2"

FQBN="rp2040:rp2040:generic_rp2350:usbstack=tinyusb,flash=2097152_0"

# USB 身份：WebHID 侧按 VID/PID 过滤
USB_FLAGS='build.extra_flags=-DUSB_VID=0x2E8A -DUSB_PID=0xF00F'
USB_PRODUCT='build.usb_product="DINE Order Box"'
USB_MANUF='build.usb_manufacturer="WaytoAGI 1024"'

# 1200 波特触碰自动进 BOOTSEL 的 python 片段
TOUCH_PY='
import serial, time, sys
port = sys.argv[1]
try:
    s = serial.Serial(port, 1200, timeout=1)
    time.sleep(0.2)
    s.close()
    print("1200-baud touch on", port, "-> reboot to BOOTSEL")
except Exception as e:
    print("touch failed:", e)
'

to_win() { cygpath -w "$1"; }

find_picotool() {
  local p
  p="$(find "$ROOT/tools/data/packages/rp2040/tools" -name 'picotool.exe' 2>/dev/null | head -1)"
  [ -n "$p" ] && to_win "$p" || true
}

do_build() {
  echo "==> 编译（$FQBN）..."
  local WIN_BUILD WIN_SRC
  WIN_BUILD="$(to_win "$BUILD_DIR")"
  WIN_SRC="$(to_win "$SRC_DIR")"
  mkdir -p "$BUILD_DIR"
  # 用 --clean 让 arduino-cli 自己清理旧产物；
  # 不要用 rm -rf（会被系统安全策略拦截，导致脚本中断）
  "$ARDUINO_CLI" --config-file "$(to_win "$CONFIG")" compile \
    --fqbn "$FQBN" \
    --build-path "$WIN_BUILD" \
    --clean \
    --build-property "$USB_FLAGS" \
    --build-property "$USB_PRODUCT" \
    --build-property "$USB_MANUF" \
    "$WIN_SRC" 2>&1 | tail -25
  [ -f "$UF2" ] || { echo "!! 编译失败，没有生成 uf2"; return 1; }
  echo "==> 编译完成: $UF2"
}

# 找出当前运行固件的 RP2350 串口（VID 0x2E8A / PID 0xF00F）
find_device_port() {
  "$PY" - <<'PYEOF'
import serial.tools.list_ports as sp
for p in sp.comports():
    if p.vid == 0x2E8A and p.pid == 0xF00F:
        print(p.device)
        break
PYEOF
}

do_flash() {
  [ -f "$UF2" ] || { echo "找不到 $UF2，请先编译"; return 1; }
  local PICOTOOL UF2_WIN
  PICOTOOL="$(find_picotool)"
  UF2_WIN="$(to_win "$UF2")"
  if [ -z "$PICOTOOL" ]; then echo "!! 找不到 picotool"; return 1; fi

  echo "==> 检测 BOOTSEL 设备（picotool info）..."
  if "$PICOTOOL" info >/dev/null 2>&1; then
    echo "==> 已在 BOOTSEL，直接 picotool 烧录"
    "$PICOTOOL" load "$UF2_WIN" -f -x
    return $?
  fi

  echo "==> 板子正在运行固件，尝试 1200 波特触碰自动重启进 BOOTSEL..."
  local PORT
  PORT="$(find_device_port)"
  if [ -n "$PORT" ]; then
    "$PY" -c "$TOUCH_PY" "$PORT"
    sleep 3
    if "$PICOTOOL" info >/dev/null 2>&1; then
      echo "==> 已进入 BOOTSEL，picotool 烧录：$UF2"
      "$PICOTOOL" load "$UF2_WIN" -f -x
      return $?
    fi
  fi

  echo "==> 回退：查找 RPI-RP2 U盘（拖拽烧录模式）"
  local DRIVE
  DRIVE="$("$PY" - <<'PYEOF'
import ctypes, string, sys
for letter in string.ascii_uppercase:
    root = letter + ":\\"
    buf = ctypes.create_unicode_buffer(256)
    fs = ctypes.create_unicode_buffer(256)
    if ctypes.windll.kernel32.GetVolumeInformationW(
            root, buf, 256, None, None, None, fs, 256) and \
            buf.value.upper().startswith("RPI-RP2"):
        print(letter + ":")
        sys.exit(0)
PYEOF
)"
  if [ -n "$DRIVE" ]; then
    echo "==> 复制 UF2 到 $DRIVE（板子会自动重启）"
    cp "$UF2" "${DRIVE}/"
    sleep 2
    return 0
  fi

  echo ""
  echo "!! 未检测到 Beetle RP2350。请："
  echo "   1. 按住板子上的【用户按键】（丝印 USER / BOOTSEL，QSPI_SS）不要松"
  echo "   2. 插上 USB 线（会出现一个名为 RPI-RP2 的 U 盘）"
  echo "   3. 重跑本脚本：bash firmware/build-flash.sh"
  echo ""
  echo "   或者手动：把 $UF2 拖进 RPI-RP2 U盘"
  return 2
}

do_verify() {
  echo "==> 自验证（9 项）..."
  "$PY" "$(to_win "$HERE/verify.py")" --timeout 30
}

# ---------------- main ----------------
PY="${DINE_PYTHON:-}"
if [ -z "$PY" ]; then
  echo "!! 请设置 DINE_PYTHON 指向带 pyserial 的 python，例如："
  echo "   DINE_PYTHON=\"E:/LC_DATA/workbuddy-local/binaries/python/envs/default/Scripts/python.exe\" bash firmware/build-flash.sh"
  exit 1
fi
[ -x "$PY" ] || PY="$(to_win "$PY")"

DO_BUILD=1; DO_FLASH=1; DO_VERIFY=1
case "${1:-}" in
  --build)  DO_FLASH=0; DO_VERIFY=0 ;;
  --flash)  DO_BUILD=0; DO_VERIFY=0 ;;
  --verify) DO_BUILD=0; DO_FLASH=0 ;;
esac

[ "$DO_BUILD" = 1 ]  && { do_build  || exit 1; }
[ "$DO_FLASH" = 1 ]  && { do_flash  || exit 1; }
[ "$DO_VERIFY" = 1 ] && { do_verify || exit 1; }
echo ""
echo "==> 全部完成 ✅"
