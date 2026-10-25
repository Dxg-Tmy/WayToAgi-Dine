#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test-physical.py — 真人按键测试（验证焊接的机械通路）

监听 HID Input Report 一段时间，你在这段时间里轮流按实体按键，
脚本实时打印收到的报文，并在结束时告诉你每个按键是否工作正常。

用法:
    DINE_PYTHON="E:/LC_DATA/workbuddy-local/binaries/python/envs/default/Scripts/python.exe" \
        python firmware/test-physical.py --seconds 25

按法建议（脚本会提示）:
    1. 短按一下 D0（按键1）
    2. 短按一下 D1（按键2）
    3. 短按一下 D4（按键3）
    4. 按住 D4 不放，超过 1 秒再松手（按键3 长按）
"""
import argparse
import ctypes
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify as V

NAMES = {
    0x01: "按键1 短按 (NEXT)   D0",
    0x02: "按键2 短按 (OK)     D1",
    0x03: "按键3 短按 (FINISH) D4",
    0x04: "按键3 长按 (FINISH) D4",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=25)
    args = ap.parse_args()

    # 找 HID 设备
    hid_path = None
    deadline = time.time() + 10
    while time.time() < deadline:
        devs = [d for d in V.hid_devices()
                if d[1] == V.VID and d[2] == V.PID and d[3] == V.USAGE_PAGE]
        if devs:
            hid_path = devs[0][0]
            break
        time.sleep(0.5)
    if not hid_path:
        print("找不到点餐盒 HID 设备，请确认 USB 已插好")
        return 1

    fh = V.hid_open(hid_path)
    if not fh:
        print("打不开 HID 设备")
        return 1

    print("=" * 60)
    print("真人按键测试 —— 现在开始按实体按键！")
    print("=" * 60)
    print("请依次操作（共 %d 秒，从 3 秒后开始计时）：" % args.seconds)
    print("  ① 短按一下 D0（按键1）")
    print("  ② 短按一下 D1（按键2）")
    print("  ③ 短按一下 D4（按键3）")
    print("  ④ 按住 D4 超过 1 秒再松手（按键3 长按）")
    print("-" * 60)

    time.sleep(3)
    print(">>> 开始监听，请按键 <<<\n")

    seen = {}
    order = []
    t0 = time.time()
    try:
        while time.time() - t0 < args.seconds:
            rep = V.hid_read_input(fh, timeout_ms=0.5)
            if not rep or len(rep) < 2:
                continue
            if rep[0] != 0x01:      # 只要 report id 1（按键上报）
                continue
            code = rep[1]
            now = time.time() - t0
            if code not in seen:
                seen[code] = 0
                order.append(code)
            seen[code] += 1
            name = NAMES.get(code, "未知编码 0x%02X" % code)
            print("  [%5.1fs] 收到 HID InputReport = %02X %02X   ->  %s"
                  % (now, rep[0], code, name))
    finally:
        k = ctypes.windll.kernel32
        k.CloseHandle(fh)

    print()
    print("=" * 60)
    print("测试结果")
    print("=" * 60)
    expected = {0x01: "按键1 短按", 0x02: "按键2 短按", 0x03: "按键3 短按", 0x04: "按键3 长按"}
    all_ok = True
    for code, label in expected.items():
        cnt = seen.get(code, 0)
        ok = cnt > 0
        all_ok = all_ok and ok
        print("  %s %-14s 收到 %d 次" % ("PASS" if ok else "FAIL", label, cnt))
    print("-" * 60)
    print("合计收到 %d 条 HID 报文" % sum(seen.values()))

    # 额外检查：短按是否连发（按一下应该只出 1 条）
    spam = [c for c, n in seen.items() if c != 0x04 and n > 4]
    if spam:
        print("\n⚠️ 注意：有按键出现多次上报（%s）。若你只按了一两下，")
        print("   可能是按键抖动/未焊牢，或线碰到了 GND。")
    else:
        print("\n✓ 无异常连发（每次按下只出一条报文，去抖正常）")

    print()
    print("结论: " + ("全部通过 ✅" if all_ok else "有项目未通过 ❌"))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
