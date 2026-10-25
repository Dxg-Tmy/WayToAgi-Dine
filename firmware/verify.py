#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify.py — 顺点·无障碍点餐盒 (Beetle RP2350) 自动验证
------------------------------------------------------------------
用法:
    DINE_PYTHON="E:/LC_DATA/workbuddy-local/binaries/python/envs/default/Scripts/python.exe" \
        python firmware/verify.py [--timeout 30]

七项验证：
  V1 串口枚举    找到 VID=0x2E8A / PID=0xF00F 的 RP2350 串口
  V2 启动横幅    串口出现 "=== mcd_order_box v..."
  V3 版本        "v" -> "[VER] mcd_order_box v2.0.0"
  V4 引脚状态    "p" -> 三个按钮均为 HIGH（内部上拉，未按）
  V5 HID 枚举    Windows HID 接口看到 UsagePage=0xFF00 的设备
  V6 HID 回传    写 Output Report(rid=2, action=2) -> 固件回显
  V7 按键发 HID  模拟短按 -> 真抓到 HID InputReport (0x01 / 0x02 / 0x03)
  V8 长按时序    "t" -> 固件内部时序自测 RESULT PASS
                 （短按/长按判定逻辑，无需人手）
  V9 长按发 HID  模拟长按 -> 真抓到 HID InputReport (0x04)

V7/V9 用 Windows HID 接口真读设备发出的报文，证明网页收到的是 HID 而非串口。
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import sys
import time

VID = 0x2E8A
PID = 0xF00F
USAGE_PAGE = 0xFF00
FW_VERSION = "2.0.0"

# GUID_DEVINTERFACE_HID = {4D1E55B2-F16F-11CF-88CB-001111000030}
# 注意：这里必须是 x86 小端内存字节序，不能用 GUID 的文本表示顺序
HID_GUID = bytes.fromhex("B2551E4D6FF1CF1188CB001111000030")
HID_IFACE_GUID_STR = "{4D1E55B2-F16F-11CF-88CB-001111000030}"
HIDCAPS_SUCCESS = 0x110000


# ==================================================================
# Windows HID 枚举（ctypes）
# ==================================================================
def _setupapi_prototypes():
    """必须声明 argtypes/restype：64 位下不声明会把句柄/指针截断成 32 位。"""
    sp = ctypes.windll.setupapi
    k = ctypes.windll.kernel32
    h = ctypes.windll.hid
    sp.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(ctypes.c_byte * 16),
                                        wt.LPWSTR, ctypes.c_void_p, wt.DWORD]
    sp.SetupDiGetClassDevsW.restype = ctypes.c_void_p
    sp.SetupDiEnumDeviceInterfaces.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                               ctypes.POINTER(ctypes.c_byte * 16),
                                               wt.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    sp.SetupDiEnumDeviceInterfaces.restype = wt.BOOL
    sp.SetupDiGetDeviceInterfaceDetailW.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
    sp.SetupDiGetDeviceInterfaceDetailW.restype = wt.BOOL
    sp.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]
    k.CreateFileW.argtypes = [wt.LPWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
                              wt.DWORD, wt.DWORD, ctypes.c_void_p]
    k.CreateFileW.restype = ctypes.c_void_p
    k.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wt.DWORD,
                           ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
    k.ReadFile.restype = wt.BOOL
    k.WriteFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wt.DWORD,
                            ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
    k.WriteFile.restype = wt.BOOL
    k.CloseHandle.argtypes = [ctypes.c_void_p]
    h.HidD_GetAttributes.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    h.HidD_GetAttributes.restype = wt.BOOL
    h.HidD_GetPreparsedData.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    h.HidD_GetPreparsedData.restype = wt.BOOL
    h.HidD_FreePreparsedData.argtypes = [ctypes.c_void_p]
    h.HidD_FreePreparsedData.restype = wt.BOOL
    h.HidP_GetCaps.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    h.HidP_GetCaps.restype = ctypes.c_long


class HIDD_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Size", wt.ULONG), ("VendorID", wt.USHORT),
                ("ProductID", wt.USHORT), ("VersionNumber", wt.USHORT)]


class HIDP_CAPS(ctypes.Structure):
    # 字段必须完整：少一个尾部字段会破坏堆导致段错误
    _fields_ = [
        ("Usage", wt.USHORT), ("UsagePage", wt.USHORT),
        ("InputReportByteLength", wt.USHORT),
        ("OutputReportByteLength", wt.USHORT),
        ("FeatureReportByteLength", wt.USHORT),
        ("Reserved", wt.USHORT * 17),
        ("NumberLinkCollectionNodes", wt.USHORT),
        ("NumberInputButtonCaps", wt.USHORT),
        ("NumberInputValueCaps", wt.USHORT),
        ("NumberInputDataIndices", wt.USHORT),
        ("NumberOutputButtonCaps", wt.USHORT),
        ("NumberOutputValueCaps", wt.USHORT),
        ("NumberOutputDataIndices", wt.USHORT),
        ("NumberFeatureButtonCaps", wt.USHORT),
        ("NumberFeatureValueCaps", wt.USHORT),
        ("NumberFeatureDataIndices", wt.USHORT),
    ]


class SP_IF_DETAIL(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("DevicePath", wt.WCHAR * 512)]


def hid_devices():
    """枚举所有 HID 设备，返回 [(path, vid, pid, usage_page, in_len, out_len)]

    主路径：走注册表（SYSTEM\\CurrentControlSet\\Enum\\HID）推导设备路径。
    备选：SetupDi 设备接口枚举（某些环境会被系统策略拦截，返回 0）。
    """
    devs = _hid_devices_registry()
    if not devs:
        devs = _hid_devices_setupapi()
    return devs


def _hid_devices_registry():
    """从注册表 Enum\\HID 找到 VID/PID 匹配的 HID 节点，拼出标准设备路径。

    设备路径格式:
        \\\\?\\HID#<硬件ID>#<实例ID>#{4D1E55B2-F16F-11CF-88CB-001111000030}
    """
    try:
        import winreg
    except ImportError:
        return []

    base = r"SYSTEM\CurrentControlSet\Enum\HID"
    instances = []
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base)
    except OSError:
        return []
    try:
        i = 0
        while True:
            try:
                hw_id = winreg.EnumKey(root, i)
            except OSError:
                break
            i += 1
            if ("VID_%04X&PID_%04X" % (VID, PID)) not in hw_id.upper():
                continue
            try:
                sub = winreg.OpenKey(root, hw_id)
            except OSError:
                continue
            try:
                j = 0
                while True:
                    try:
                        inst = winreg.EnumKey(sub, j)
                    except OSError:
                        break
                    j += 1
                    instances.append((hw_id, inst))
            finally:
                winreg.CloseKey(sub)
    finally:
        winreg.CloseKey(root)

    out = []
    for hw_id, inst in instances:
        path = "\\\\?\\HID#%s#%s#%s" % (hw_id, inst, HID_IFACE_GUID_STR)
        info = _hid_open_info(path)
        if info:
            out.append(info)
    return out


def _hid_open_info(path):
    """打开 HID 路径并读取 VID/PID/UsagePage，返回元组；失败返回 None"""
    _setupapi_prototypes()
    k = ctypes.windll.kernel32
    hid = ctypes.windll.hid

    fh = k.CreateFileW(path, 0, 0x00000003, None, 3, 0, None)
    if not fh or fh == ctypes.c_void_p(-1).value:
        return None
    try:
        ha = HIDD_ATTRIBUTES()
        ha.Size = ctypes.sizeof(HIDD_ATTRIBUTES)
        if not hid.HidD_GetAttributes(fh, ctypes.byref(ha)):
            return None
        pre = ctypes.c_void_p()
        if not hid.HidD_GetPreparsedData(fh, ctypes.byref(pre)):
            return None
        try:
            caps = HIDP_CAPS()
            if hid.HidP_GetCaps(pre, ctypes.byref(caps)) != HIDCAPS_SUCCESS:
                return None
            upage, inlen, outlen = (caps.UsagePage, caps.InputReportByteLength,
                                    caps.OutputReportByteLength)
        finally:
            hid.HidD_FreePreparsedData(pre)
        return (path, ha.VendorID, ha.ProductID, upage, inlen, outlen)
    finally:
        k.CloseHandle(fh)


def _hid_devices_setupapi():
    """备选：SetupDi 设备接口枚举（部分环境被系统策略拦截）"""
    _setupapi_prototypes()
    sp = ctypes.windll.setupapi
    k = ctypes.windll.kernel32
    hid = ctypes.windll.hid

    guid = (ctypes.c_byte * 16).from_buffer_copy(HID_GUID)
    hdev = sp.SetupDiGetClassDevsW(ctypes.byref(guid), None, None, 0x12)
    if hdev in (None, ctypes.c_void_p(-1).value, 0xFFFFFFFFFFFFFFFF):
        return []

    out = []
    detail = SP_IF_DETAIL()
    detail.cbSize = ctypes.sizeof(SP_IF_DETAIL)
    idx = 0
    while True:
        iface = ctypes.c_void_p()
        if not sp.SetupDiEnumDeviceInterfaces(hdev, None, ctypes.byref(guid),
                                             idx, ctypes.byref(iface)):
            break
        idx += 1
        got = sp.SetupDiGetDeviceInterfaceDetailW(
            hdev, ctypes.byref(iface), ctypes.byref(detail),
            ctypes.sizeof(SP_IF_DETAIL), None, None)
        if not got:
            continue
        # DevicePath 偏移 4 字节（cbSize 之后）
        path = ctypes.wstring_at(ctypes.addressof(detail) + 4)
        info = _hid_open_info(path)
        if info:
            out.append(info)
    sp.SetupDiDestroyDeviceInfoList(hdev)
    return out


def hid_open(path):
    """以读写方式打开 HID 设备（共享读写，不独占）"""
    k = ctypes.windll.kernel32
    fh = k.CreateFileW(path, 0xC0000000, 0x00000003, None, 3, 0, None)
    if not fh or fh == ctypes.c_void_p(-1).value:
        return None
    return fh


def hid_write_output(fh, report_id, data):
    """写 Output Report：缓冲区第 0 字节必须是 report id"""
    k = ctypes.windll.kernel32
    buf = (ctypes.c_ubyte * (1 + len(data)))(report_id, *data)
    written = wt.DWORD(0)
    ok = k.WriteFile(fh, buf, 1 + len(data), ctypes.byref(written), None)
    return bool(ok) and written.value == 1 + len(data)


def hid_read_input(fh, timeout_ms=3.0):
    """读 Input Report：返回 bytes（首字节为 report id），超时返回 None"""
    k = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(64)
    read = wt.DWORD(0)
    deadline = time.time() + timeout_ms
    while time.time() < deadline:
        ok = k.ReadFile(fh, buf, 64, ctypes.byref(read), None)
        if ok and read.value:
            return bytes(buf.raw[:read.value])
    return None


# ==================================================================
# 串口工具
# ==================================================================
def find_serial(wait_s=8.0):
    """找 RP2350 串口；板子刚复位/烧录后 USB 需要重新枚举，最多等 wait_s 秒"""
    import serial.tools.list_ports as sp
    deadline = time.time() + wait_s
    while True:
        for p in sp.comports():
            if p.vid == VID and p.pid == PID:
                return p.device
        if time.time() >= deadline:
            return None
        time.sleep(0.4)


def serial_read_lines(ser, count=3, timeout=2.0, stop_marker=None):
    lines = []
    end = time.time() + timeout
    while time.time() < end and len(lines) < count:
        raw = ser.readline()
        if not raw:
            continue
        try:
            s = raw.decode("utf-8", errors="replace").strip()
        except Exception:
            s = str(raw).strip()
        if s:
            lines.append(s)
            if stop_marker and stop_marker in s:
                break
    return lines


def expect(lines, needle):
    return any(needle in l for l in lines)


# ==================================================================
# 主流程
# ==================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--port", default=None)
    args = ap.parse_args()

    import serial

    results = []

    def add(tag, name, ok, detail):
        results.append((tag, name, ok, detail))
        print(("[PASS] " if ok else "[FAIL] ") + tag + " " + name +
              (("  -- " + detail) if detail else ""))

    print("=" * 62)
    print("顺点·无障碍点餐盒 — Beetle RP2350 固件自动验证")
    print("=" * 62)

    # ---------- V1 串口枚举 ----------
    port = args.port or find_serial()
    if not port:
        print("[FAIL] V1 串口枚举 -- 未找到 VID=0x%04X PID=0x%04X 设备" % (VID, PID))
        print("       请确认板子已插好 USB 并已烧入固件")
        return 1
    add("V1", "串口枚举 %s (VID=0x%04X PID=0x%04X)" % (port, VID, PID), True, port)

    ser = serial.Serial(port, 115200, timeout=0.4)
    time.sleep(0.6)
    ser.reset_input_buffer()

    # ---------- V2 启动横幅 ----------
    ser.write(b"i\n"); ser.flush()
    l2 = serial_read_lines(ser, 3, timeout=3.0, stop_marker="[READY]")
    ok2 = expect(l2, "=== mcd_order_box v")
    add("V2", "启动横幅", ok2, l2[-1] if l2 else "无响应")

    # ---------- V3 版本 ----------
    ser.write(b"v\n"); ser.flush()
    l3 = serial_read_lines(ser, 3, timeout=3.0, stop_marker="[VER]")
    ok3 = expect(l3, "[VER] mcd_order_box v" + FW_VERSION)
    add("V3", "固件版本 v" + FW_VERSION, ok3, l3[-1] if l3 else "无响应")

    # ---------- V4 引脚状态 ----------
    ser.write(b"p\n"); ser.flush()
    l4 = serial_read_lines(ser, 3, timeout=3.0, stop_marker="[PIN]")
    ok4 = expect(l4, "[PIN] BTN1=1 BTN2=1 BTN3=1")
    add("V4", "按钮引脚（内部上拉，未按=1）", ok4, l4[-1] if l4 else "无响应")

    # ---------- V5 HID 枚举（板子刚复位后接口需要重新出现，最多等 10s） ----------
    hid_path = None
    devs = []
    deadline = time.time() + 10.0
    while time.time() < deadline:
        devs = [d for d in hid_devices()
                if d[1] == VID and d[2] == PID and d[3] == USAGE_PAGE]
        if devs:
            break
        time.sleep(0.5)
    hid_path = devs[0][0] if devs else None
    ok5 = bool(devs)
    add("V5", "HID 枚举 UsagePage=0x%04X" % USAGE_PAGE, ok5,
        ("in=%dB out=%dB" % (devs[0][4], devs[0][5])) if devs else "未找到厂商 HID 接口")

    # ---------- V6 HID 回传（网页 -> 设备） ----------
    if hid_path:
        fh = hid_open(hid_path)
        if fh:
            ser.reset_input_buffer()
            good = hid_write_output(fh, 0x02, bytes([0x02]))
            l6 = serial_read_lines(ser, 4, timeout=3.0, stop_marker="[HID] OUT")
            ok6 = good and expect(l6, "action=2")
            add("V6", "HID 回传 Output Report(rid=2,action=2)", ok6,
                l6[-1] if l6 else "固件未回显")
            k = ctypes.windll.kernel32
            k.CloseHandle(fh)
        else:
            add("V6", "HID 回传 Output Report(rid=2,action=2)", False, "无法打开 HID 设备")
    else:
        add("V6", "HID 回传 Output Report(rid=2,action=2)", False, "无 HID 设备")

    # ---------- V7 短按是否真的发 HID ----------
    # 用串口命令模拟短按（与实体按键走同一 sendCode 路径），
    # 然后用 Windows HID 接口真读设备发出的 InputReport。
    if hid_path:
        fh = hid_open(hid_path)
        if fh:
            got_codes = {}
            for key, code in (("n", 0x01), ("o", 0x02), ("f", 0x03)):
                ser.reset_input_buffer()
                ser.write(key.encode() + b"\n"); ser.flush()
                rep = hid_read_input(fh, timeout_ms=3.0)
                if rep and len(rep) >= 2 and rep[0] == 0x01:
                    got_codes[key] = rep[1]
                else:
                    got_codes[key] = None
            ok7 = (got_codes["n"] == 0x01 and got_codes["o"] == 0x02
                   and got_codes["f"] == 0x03)
            add("V7", "短按 -> HID InputReport 0x01/0x02/0x03", ok7,
                "n=%s o=%s f=%s" % (got_codes["n"], got_codes["o"], got_codes["f"]))

            # ---------- V9 长按 -> HID InputReport 0x04 ----------
            ser.reset_input_buffer()
            ser.write(b"l\n"); ser.flush()
            rep = hid_read_input(fh, timeout_ms=3.0)
            ok9 = bool(rep) and len(rep) >= 2 and rep[0] == 0x01 and rep[1] == 0x04
            add("V9", "长按 -> HID InputReport 0x04", ok9,
                ("0x%02X" % rep[1]) if rep and len(rep) >= 2 else "未抓到长按报文")

            k = ctypes.windll.kernel32
            k.CloseHandle(fh)
        else:
            add("V7", "短按 -> HID InputReport", False, "无法打开 HID 设备")
            add("V9", "长按 -> HID InputReport", False, "无法打开 HID 设备")
    else:
        add("V7", "短按 -> HID InputReport", False, "无 HID 设备")
        add("V9", "长按 -> HID InputReport", False, "无 HID 设备")

    # ---------- V8 长按时序自测（固件内部逻辑） ----------
    ser.reset_input_buffer()
    ser.write(b"t\n"); ser.flush()
    l8 = serial_read_lines(ser, 12, timeout=5.0, stop_marker="[TEST] RESULT")
    ok8 = expect(l8, "[TEST] RESULT PASS")
    detail8 = " / ".join(x for x in l8 if x.startswith("[TEST]"))[:180] if l8 else "无响应"
    add("V8", "长短按时序自测（固件内部）", ok8, detail8)

    ser.close()

    # ---------- 汇总 ----------
    print("=" * 62)
    passed = sum(1 for r in results if r[2])
    total = len(results)
    print("结果: %d/%d 通过" % (passed, total))
    for tag, name, ok, detail in results:
        print("  %s %-4s %s" % ("PASS" if ok else "FAIL", tag, name))
    print("=" * 62)
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
