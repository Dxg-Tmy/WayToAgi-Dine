# 固件：mcd_order_box（DFRobot Beetle RP2350）v2.0.0

三键无障碍点餐盒。三个物理按键通过 USB 自定义 Vendor HID 与网页「麦点点」通信，
全程不依赖视觉：按一下，网页语音播报一项。

## 接线（以板子丝印为准，可在 .ino 顶部 #define 修改）

| 板子丝印 | GPIO | 接法 | 功能 | 上报码 |
|---|---|---|---|---|
| D0 | GP0 | 按键一脚接 D0，另一脚接 **GND** | 【下一个】浏览下一项 | `0x01` |
| D1 | GP1 | 按键一脚接 D1，另一脚接 **GND** | 【确定】加入购物车 | `0x02` |
| D4 | GP4 | 按键一脚接 D4，另一脚接 **GND** | 【完成】去结算 | `0x03` 短按 / `0x04` 长按 |

- **不需要外接上拉/下拉电阻**：固件已开 `INPUT_PULLUP`（未按 = 高电平 1，按下接地 = 低电平 0）。
- 机械按键 4 脚封装内部是两对短接，**只用其中一对**。
- 板载 GP25 LED 每秒心跳一次，仅作"固件在跑"指示，未引出到排针。
- ⚠️ D0 同时是 TX1、D4 是 SDA、D8 是 TX2 —— 做普通 GPIO 没问题，但别接 I²C 设备到 D4。

## 按键语义（重要）

| 场景 | 行为 |
|---|---|
| 按钮1 / 按钮2 | 按下→松开（<800ms）上报 **1 次** `0x01` / `0x02` |
| 按钮3 **短按** | 按下→松开（<800ms）上报 **1 次** `0x03` |
| 按钮3 **长按** | 按住 **≥800ms** 时**立即**上报 **1 次** `0x04`；松开**不再**补发 `0x03` |
| 任意键 | 30ms 去抖，**一次物理按下只产生一条报文，绝不连发** |

按钮3 是"二选一"语义：要么 `0x03`（短按），要么 `0x04`（长按），不会先 3 再 4。

## 通信协议（Usage Page 0xFF00 厂商自定义）

- **Input Report（ID 1）**：`[按键码]`，1 字节
  `0x01`=下一个 / `0x02`=确定 / `0x03`=完成（短按）/ `0x04`=完成（长按）
- **Output Report（ID 2）**：`[动作]`，`0x01`=确认 / `0x02`=连接成功 / `0x03`=错误
  —— v2.0.0 硬件已去掉 LED/蜂鸣器，设备侧**只记录不回显动作**，协议保留以便后续扩展。

网页端用 WebHID（`navigator.hid`，桌面 Chrome/Edge）接收；未插硬件时自动降级为键盘/触屏，流程完全一致。
完整对接文档见 [`HID_PROTOCOL.md`](HID_PROTOCOL.md)。

## 编译、烧录、验证（一键）

```bash
DINE_PYTHON="E:/LC_DATA/workbuddy-local/binaries/python/envs/default/Scripts/python.exe" \
    bash firmware/build-flash.sh
```

一条命令完成：**编译 → 自动烧录 → 9 项自动验证**，全程无需手动按 BOOTSEL 键。

| 参数 | 作用 |
|---|---|
| `bash firmware/build-flash.sh` | 全流程（编译+烧录+验证）|
| `bash firmware/build-flash.sh --build` | 只编译，产出 `firmware/build/mcd_order_box.ino.uf2` |
| `bash firmware/build-flash.sh --flash` | 只烧录（用已编译的 uf2）|
| `bash firmware/build-flash.sh --verify` | 只跑 9 项自测 |

烧录原理：脚本检测到板子正在运行旧固件时，会用 **1200 波特触碰**触发 Arduino 核心软重启进 BOOTSEL，
再用 picotool 烧录 —— **不需要手按板子上的 BOOTSEL 键**。

### 方式二：Arduino IDE

1. 文件 → 首选项 → 附加开发板管理器网址，加：
   `https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`
2. 开发板管理器搜 `Arduino-Pico`（earlephilhower 核心）安装
3. 工具菜单选：开发板 **generic**（RP2350）、**USB Stack: TinyUSB**（必须，否则没有 HID）
4. 打开 `mcd_order_box/mcd_order_box.ino` → 上传

### 烧录说明

- **UF2 方式**：按住 Beetle RP2350 的 **BOOT** 键再插 USB，出现 U 盘后把 `.uf2` 拖进去，自动重启即完成。
- **串口方式**：板子已烧过本固件时，`arduino-cli upload --port COMx` 可自动进入下载模式。

## 自动验证（9 项，`firmware/verify.py`）

```bash
DINE_PYTHON="E:/LC_DATA/workbuddy-local/binaries/python/envs/default/Scripts/python.exe" \
    python firmware/verify.py --timeout 30
```

| 项 | 内容 |
|---|---|
| V1 | 串口枚举（VID=0x2E8A / PID=0xF00F）|
| V2 | 启动横幅 |
| V3 | 固件版本 `v2.0.0` |
| V4 | 按钮引脚状态（未按 = HIGH）|
| V5 | HID 枚举 UsagePage=0xFF00 |
| V6 | HID 回传（网页 → 设备 Output Report）|
| V7 | 短按 → **真抓** HID InputReport `0x01/0x02/0x03` |
| V8 | 固件内部长短按时序自测（`t` 命令，无需人手）|
| V9 | 长按 → **真抓** HID InputReport `0x04` |

## 调试串口命令（115200 8N1，纯 ASCII）

| 命令 | 作用 |
|---|---|
| `n` / `o` / `f` | 模拟按钮1/2/3 短按 |
| `l` | 模拟按钮3 长按 |
| `t` | 固件内部时序自测（输出 `[TEST] RESULT PASS`）|
| `v` / `i` / `p` | 版本 / 启动横幅 / 引脚状态 |
| `b` | 重启进 BOOTSEL（烧录用）|
| `h` | 帮助 |

`n/o/f/l` 与实体按键走**同一段发送代码**，因此网页联调时用串口助手模拟按键完全等效。

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 网页找不到设备 | 浏览器不支持 WebHID | 换桌面 Chrome/Edge 89+ |
| 按键无反应 | 引脚与丝印不符 | 对照丝印改 .ino 顶部 #define |
| 烧录失败 | 没进 BOOTSEL | 用一键脚本（自动 1200 波特触碰），或按住 BOOT 再插 USB |
| 网页收到 `0x03` 又收到 `0x04` | 固件版本旧 | 重烧 v2.0.0（短/长已改为二选一）|
| 验证报 V1/V5 失败 | 板子刚复位，USB 未重新枚举 | 等待 10 秒后重跑 `verify.py` |
