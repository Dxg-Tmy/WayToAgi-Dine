# 麦点点 · 无障碍点餐盒 — 硬件 ↔ 网页通信协议 v2.0.0

> **给网页组的对接文档**（硬件：DFRobot Beetle RP2350 三键点餐盒，固件 v2.0.0）
>
> 本文档即全部对接内容，**无需再问硬件侧**。文末附复制即用的完整代码。

---

## 0. 30 秒速览（先看这个）

1. 用 **WebHID** 连设备，过滤条件 `usagePage: 0xFF00`（设备 `VID=0x2E8A` / `PID=0xF00F`）。
2. 监听 `inputreport` 事件，当 `reportId === 1` 时读 `data.getUint8(0)`，得到 1 字节按键码：
   | 码 | 含义 |
   |---|---|
   | `0x01` | 按钮1 短按 = 下一个 |
   | `0x02` | 按钮2 短按 = 确定 |
   | `0x03` | 按钮3 短按 = 完成 |
   | `0x04` | 按钮3 长按 = 完成（长按） |
3. 按钮3 只会出 `0x03` 或 `0x04` **其中之一**，不会连发、不会先 3 再 4。
4. 网页可以回发反馈（可选，当前硬件无执行器，设备只记录）：`sendReport(2, [action])`。

---

## 1. 设备身份与连接条件

| 项 | 值 |
|---|---|
| 接口 | USB HID（免驱，操作系统自带） |
| 厂商自定义 Usage Page | `0xFF00` |
| Vendor ID | `0x2E8A` |
| Product ID | `0xF00F` |
| 产品名 | `DINE Order Box` |
| 厂商名 | `WaytoAGI 1024` |
| HID 协议类型 | `HID_ITF_PROTOCOL_NONE`（自定义设备，**不是键盘/鼠标**）|
| Input Report | ID = `1`，载荷 1 字节（设备 → 网页）|
| Output Report | ID = `2`，载荷 1 字节（网页 → 设备）|

**浏览器要求**：
- 仅 **Chrome / Edge 桌面版**（WebHID 不支持手机浏览器）。
- 页面必须经 `http://localhost` 或 `https://` 打开；**直接双击 `file://` 打开时 WebHID 被禁用**。
- `navigator.hid.requestDevice()` 必须在**用户点击等用户手势**里调用（不能页面加载时自动弹）。

---

## 2. 设备 → 网页：Input Report（按键上报）

**Report ID = 1，载荷 1 字节。**

| 载荷 | 含义 | 触发条件 |
|---|---|---|
| `0x01` | NEXT 下一个 | 按钮1 短按（按下→松开，总时长 < 800ms）|
| `0x02` | OK 确定 | 按钮2 短按（同上）|
| `0x03` | FINISH 完成 | 按钮3 **短按**（< 800ms）|
| `0x04` | FINISH_LONG 完成（长按）| 按钮3 **长按**（按住 ≥ 800ms）|

### 触发规则（请务必按此实现前端逻辑）

| 场景 | 硬件行为 |
|---|---|
| 按钮1 / 按钮2 | 松开时上报 **1 次** |
| 按钮3 短按 | 松开时上报 **1 次** `0x03` |
| 按钮3 长按 | 按住满 800ms 的**当下立即**上报 **1 次** `0x04`；**之后松开不再补发** `0x03` |
| 任意按键 | 30ms 硬件去抖，**一次物理按下只产生一条报文，绝不连发** |

> **按钮3 是"二选一"语义**：要么 `0x03`（短按），要么 `0x04`（长按），
> **绝不会先收到 `0x03` 又收到 `0x04`**。
> 因此前端可以放心把 `0x04` 用作"长按二次确认 / 下单"这类需要防误触的动作。

### 网页侧读取代码

```js
device.addEventListener('inputreport', (e) => {
  if (e.reportId !== 1) return;          // 只认按键上报
  const code = e.data.getUint8(0);       // WebHID 已去掉 Report ID 字节，直接就是载荷
  switch (code) {
    case 0x01: onNext();       break;    // 下一个
    case 0x02: onOk();         break;    // 确定
    case 0x03: onFinish();     break;    // 完成（短按）
    case 0x04: onFinishLong(); break;    // 完成（长按）——建议做二次确认
    default:   console.warn('未知按键码', code);
  }
});
```

> ⚠️ **注意**：`e.data` 里**不含** Report ID 字节（WebHID 已剥离），所以是 `getUint8(0)`，
> 不是 `getUint8(1)`。底层 USB 线材上是 `01 <code>` 两字节，但到 JS 里只剩 `<code>`。

---

## 3. 网页 → 设备：Output Report（反馈，可选）

**Report ID = 2，载荷 1 字节。**

| 载荷 | 含义 |
|---|---|
| `0x01` | BLINK 确认 |
| `0x02` | CONNECTED 连接成功 |
| `0x03` | ERROR 错误 |

> ⚠️ **v2.0.0 硬件已去掉 LED 和蜂鸣器**，设备收到这些报文**只做记录，不会亮灯/响铃**。
> 协议保留是为了后续加回执行器时网页代码不用改。
> **网页侧可以完全不发 Output Report，不影响按键功能。**

```js
await device.sendReport(2, new Uint8Array([2]));   // 可选：连接成功握手
```

---

## 4. 连接时序（建议照此实现）

```
用户点击「连接点餐盒」按钮
   └─> navigator.hid.requestDevice({ filters: [{ usagePage: 0xff00 }] })
         └─> 用户在浏览器弹窗里选中设备
               └─> device.open()
                     ├─> 订阅 inputreport 监听
                     ├─>（可选）sendReport(2, [2]) 握手
                     └─> 之后每次实体按键都会触发 inputreport 事件
```

**卸载/断开**：页面关闭时浏览器会自动 `close()`；如需手动断开调用 `device.close()`。
设备**不支持热插拔时自动重连**，掉线后需让用户重新点一次连接按钮（WebHID 规范行为）。

---

## 5. 复制即用的完整对接代码

```js
// ---------- 1. 连接 ----------
async function connectBox() {
  // 必须在用户手势里调用
  const [device] = await navigator.hid.requestDevice({
    filters: [{ usagePage: 0xff00 }]           // 只列出我们的点餐盒
  });
  if (!device) return null;

  await device.open();

  // 订阅按键上报
  device.addEventListener('inputreport', onBoxInput);

  // 可选握手（设备只记录，无执行器）
  try { await device.sendReport(2, new Uint8Array([2])); } catch (_) {}

  return device;
}

// ---------- 2. 收按键 ----------
function onBoxInput(e) {
  if (e.reportId !== 1) return;
  const code = e.data.getUint8(0);
  switch (code) {
    case 0x01: onNext();       break;   // 下一个
    case 0x02: onOk();         break;   // 确定
    case 0x03: onFinish();     break;   // 完成（短按）
    case 0x04: onFinishLong(); break;   // 完成（长按）
  }
}

// ---------- 3. 断开 ----------
async function disconnectBox(device) {
  device.removeEventListener('inputreport', onBoxInput);
  await device.close();
}

// ---------- 4. 能力检测（没插硬件时优雅降级）----------
const hasBox = 'hid' in navigator;   // false 时走纯键盘/触屏路径
```

---

## 6. 与现有虚拟按键的对应关系

网页已有的虚拟按键 / 键盘事件，直接映射到上面 4 个码即可，**实体与虚拟流程完全一致**：

| 网页动作 | 对应码 |
|---|---|
| ▲ 往上选 / 下一个 | `0x01` |
| 确定 | `0x02` |
| 完成 / 进结算 | `0x03` |
| 长按确定（≥800ms）| `0x04` |

---

## 7. 本地联调（不用反复按实体键）

硬件侧提供调试串口（`115200 8N1`，纯 ASCII）。用任意串口助手打开后发命令，
**与实体按键走同一段发送代码**，效果完全等效：

| 命令 | 等效于 |
|---|---|
| `n` | 按一下按钮1 |
| `o` | 按一下按钮2 |
| `f` | 按一下按钮3（短）|
| `l` | 按一下按钮3（长）|
| `v` | 查版本 |

> 联调时若实体键不在手边，用串口助手发 `n/o/f/l` 即可驱动网页，
> 网页收到的报文与真人按键**一字不差**。

---

## 8. 已实测验证（硬件侧证据）

以下均在实板（DFRobot Beetle RP2350 + 真人按键）上抓包确认：

| 项 | 结果 |
|---|---|
| 设备枚举 | `usagePage=0xFF00`，Input 2 字节 / Output 2 字节 |
| 按钮1 短按 | 抓到 HID 报文 `01 01` |
| 按钮2 短按 | 抓到 HID 报文 `01 02` |
| 按钮3 短按 | 抓到 HID 报文 `01 03` |
| 按钮3 长按 | 抓到 HID 报文 `01 04` |
| 长按语义 | 长按只出 `04`，松开后**不补发** `03`（一次按下一条报文）|
| 去抖 | 无连发，单次按下仅一条报文 |
| 反向通道 | 网页 `sendReport(2, [2])` → 固件确认收到 |

---

## 9. 接线参考（硬件侧存档，网页组一般不用看）

| 丝印 | GPIO | 接法 | 功能 |
|---|---|---|---|
| D0 | GP0 | 一脚接 D0，另一脚接 GND | 按钮1 下一个 |
| D1 | GP1 | 一脚接 D1，另一脚接 GND | 按钮2 确定 |
| D4 | GP4 | 一脚接 D4，另一脚接 GND | 按钮3 完成（短/长）|

固件已开启内部上拉，**无需外接电阻**；未按 = 高电平，按下接地 = 低电平。

---

## 10. 一句话总结

> 连 `usagePage: 0xff00` 的设备 → 监听 `reportId===1` 的 `inputreport` → 读 `data.getUint8(0)`：
> `1`=下一个、`2`=确定、`3`=完成（短按）、`4`=完成（长按）。
> 按钮3 只出 `3` 或 `4` 之一，绝不连发。Output Report 可选，发了设备也只记录。
