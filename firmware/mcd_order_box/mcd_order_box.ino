/*
 * mcd_order_box.ino — 麦点点·无障碍点餐盒 (DFRobot Beetle RP2350)
 * ------------------------------------------------------------
 * 通信方式: USB HID（TinyUSB 自定义 Vendor HID，Usage Page 0xFF00）
 *          网页侧用 WebHID 连接，详见 HID_PROTOCOL.md。
 *          说明: RP2350 可做 USB HID Device；ESP32-C3 不能（已弃用该方案）。
 *
 * 引脚（仅 3 个按钮，均 INPUT_PULLUP，另一端接 GND；"按下"=LOW）：
 *   按钮1 NEXT   -> D0  (GP0)   仅需短按
 *   按钮2 OK     -> D1  (GP1)   仅需短按
 *   按钮3 FINISH -> D4  (GP4)   短按 + 长按
 *   板载 LED     -> GP25        心跳指示（板子自带，无需接线）
 *
 * HID Input Report（设备 -> 网页, reportId=1），1 字节：
 *   0x01 = 按钮1 短按 (NEXT)
 *   0x02 = 按钮2 短按 (OK)
 *   0x03 = 按钮3 短按 (FINISH)
 *   0x04 = 按钮3 长按 (FINISH long)
 * HID Output Report（网页 -> 设备, reportId=2），1 字节：反馈动作
 *   （当前硬件无执行器，设备仅接收记录，协议保留以便后续扩展）
 *
 * 按键判定：
 *   - 短按：在「松开」沿触发（按下时间 < LONG_PRESS_MS 且未触发过长按）
 *   - 长按：按住超过 LONG_PRESS_MS 时触发一次（仅按钮3）
 *   - 全程 30ms 去抖；一次物理按下只产生一个事件（不连发）
 *
 * 调试串口命令（串口监视器，亦供 verify.py 使用）：
 *   n/o/f = 模拟 按钮1/2/3 短按
 *   l     = 模拟 按钮3 长按
 *   v     = 版本   p = 引脚状态   b = 重启进 BOOTSEL   h = 帮助
 */

#include <Arduino.h>
#include <Adafruit_TinyUSB.h>

#define FW_VERSION "2.0.0"

// ---------------- 引脚定义 ----------------
#define PIN_BTN1        0    // D0  -> GP0   按钮1 NEXT
#define PIN_BTN2        1    // D1  -> GP1   按钮2 OK
#define PIN_BTN3        4    // D4  -> GP4   按钮3 FINISH（短按+长按）
#define PIN_LED_ONBOARD 25   // GP25 板载心跳 LED（无需接线）

// ---------------- HID 上报编码（Input report 数据字节） ----------------
#define CODE_BTN1_SHORT 0x01
#define CODE_BTN2_SHORT 0x02
#define CODE_BTN3_SHORT 0x03
#define CODE_BTN3_LONG  0x04

// 网页反馈动作（Output report 数据字节，当前仅记录）
#define ACT_BLINK   1
#define ACT_CONNECT 2
#define ACT_ERROR   3

// ---------------- 时序参数 ----------------
#define DEBOUNCE_MS   30    // 去抖窗口
#define LONG_PRESS_MS 800   // 长按阈值（按住超过此值触发长按）

// ---------------- HID 报告描述符 ----------------
// Usage Page 0xFF00（厂商自定义），Input reportId=1（1 字节），Output reportId=2（1 字节）
uint8_t const HID_REPORT_DESC[] = {
  0x06, 0x00, 0xFF,        // Usage Page (Vendor Defined 0xFF00)
  0x09, 0x01,              // Usage (0x01)
  0xA1, 0x01,              // Collection (Application)
    0x85, 0x01,            //   Report ID (1) — Input
    0x09, 0x02,            //   Usage (0x02)
    0x15, 0x00,            //   Logical Minimum (0)
    0x25, 0x0F,            //   Logical Maximum (15)
    0x75, 0x08,            //   Report Size (8)
    0x95, 0x01,            //   Report Count (1)
    0x81, 0x02,            //   Input (Data,Var,Abs)
    0x85, 0x02,            //   Report ID (2) — Output
    0x09, 0x03,            //   Usage (0x03)
    0x15, 0x00,            //   Logical Minimum (0)
    0x25, 0x0F,            //   Logical Maximum (15)
    0x75, 0x08,            //   Report Size (8)
    0x95, 0x01,            //   Report Count (1)
    0x91, 0x02,            //   Output (Data,Var,Abs)
  0xC0                     // End Collection
};

Adafruit_USBD_HID usb_hid(HID_REPORT_DESC, sizeof(HID_REPORT_DESC),
                          HID_ITF_PROTOCOL_NONE, 4, true);

// ---------------- 按钮状态机 ----------------
// 纯逻辑：给定 (当前电平, 当前时间) 返回事件码（0 = 无事件）
// 抽成独立函数是为了让"长按"时序能被串口命令 't' 自动自测（不依赖人手）
struct Btn {
  uint8_t  pin;
  uint8_t  codeShort;   // 短按上报码
  bool     hasLong;     // 是否支持长按（仅按钮3）
  bool     lastStable;  // 上次稳定电平
  uint32_t lastChange;
  uint8_t  state;       // 0=idle, 1=pressing
  uint32_t pressStart;
  bool     longFired;
};
Btn btns[3] = {
  { PIN_BTN1, CODE_BTN1_SHORT, false, HIGH, 0, 0, 0, false },
  { PIN_BTN2, CODE_BTN2_SHORT, false, HIGH, 0, 0, 0, false },
  { PIN_BTN3, CODE_BTN3_SHORT, true,  HIGH, 0, 0, 0, false },
};

uint8_t updateButton(Btn& b, bool cur, uint32_t now) {
  uint8_t evt = 0;
  if (cur != b.lastStable) {
    if (now - b.lastChange >= DEBOUNCE_MS) {
      b.lastStable = cur;
      b.lastChange = now;
      if (cur == LOW) {
        // 按下沿：进入 pressing，记录起点
        b.state = 1;
        b.pressStart = now;
        b.longFired = false;
      } else {
        // 松开沿：判定本次按下是短按还是长按
        if (b.state == 1) {
          if (b.hasLong && (b.longFired || (now - b.pressStart >= LONG_PRESS_MS))) {
            // 长按（已在按住期间触发过，或按住时长已越界但尚未触发）——不发短按
            if (!b.longFired) {
              evt = CODE_BTN3_LONG;
              b.longFired = true;
            }
          } else {
            evt = b.codeShort;
          }
        }
        b.state = 0;
      }
    } else {
      b.lastStable = cur; // 吸收抖动
    }
  }
  // 长按判定（仅按钮3，按住期间触发一次）
  if (b.hasLong && b.state == 1 && !b.longFired &&
      (now - b.pressStart >= LONG_PRESS_MS)) {
    evt = CODE_BTN3_LONG;
    b.longFired = true;
  }
  return evt;
}

// ---------------- 基础函数 ----------------
void sendCode(uint8_t code) {
  // 非阻塞：仅把报文塞进 USB 端点缓冲区即返回，不阻塞主循环
  usb_hid.sendReport(0x01, &code, 1);
}

void onOutputReport(uint8_t report_id, hid_report_type_t report_type,
                    uint8_t const* buffer, uint16_t bufsize) {
  if (bufsize < 1) return;
  uint8_t action = buffer[0];
  // OUT 端点实际送达 report_id 恒为 0，按载荷解析即可
  if (bufsize >= 2 && buffer[0] == 0x02) action = buffer[1];
  if (action < ACT_BLINK || action > ACT_ERROR) {
    Serial.print("[HID] OUT ignored rid="); Serial.print(report_id);
    Serial.print(" data="); Serial.println(action);
    return;
  }
  Serial.print("[HID] OUT rid="); Serial.print(report_id);
  Serial.print(" action="); Serial.println(action);
}

// 调试：模拟一次上报（与实体按键走同一 sendCode 路径）
void simPress(uint8_t code, const char* name) {
  sendCode(code);
  Serial.print("[BTN] ");
  Serial.print(name);
  Serial.print(" -> 0x");
  Serial.println(code, HEX);
}

// ---------------- 主循环按键处理 ----------------
void handleButtons() {
  unsigned long now = millis();
  for (int i = 0; i < 3; i++) {
    Btn& b = btns[i];
    uint8_t evt = updateButton(b, digitalRead(b.pin), now);
    if (evt == 0) continue;
    sendCode(evt);
    if (evt == CODE_BTN3_LONG) {
      Serial.println("[BTN] FINISH long -> 0x04");
    } else {
      Serial.print("[BTN] ");
      Serial.print(i == 0 ? "NEXT" : (i == 1 ? "OK" : "FINISH"));
      Serial.print(" short -> 0x");
      Serial.println(evt, HEX);
    }
  }
}

// ---------------- 时序自测（不依赖实体按键） ----------------
// 用虚拟电平序列驱动同一套 updateButton 状态机，验证：
//   1) 三个按钮短按各产生一次短按事件
//   2) 按钮3 长按只产生长按事件（不再补发短按）
//   3) 长按后松开不会产生第二次事件
void selfTestTiming() {
  Serial.println("[TEST] timing self-test begin");
  int pass = 0, fail = 0;

  // 用例 1：短按（按下 50ms 后松开）
  struct { uint8_t code; bool hasLong; const char* name; } cases[3] = {
    { CODE_BTN1_SHORT, false, "BTN1" },
    { CODE_BTN2_SHORT, false, "BTN2" },
    { CODE_BTN3_SHORT, true,  "BTN3" },
  };
  for (int i = 0; i < 3; i++) {
    Btn t = { 255, cases[i].code, cases[i].hasLong, HIGH, 0, 0, 0, false };
    uint8_t evts[4]; int n = 0;
    uint32_t base = 1000;
    // 按下
    evts[n++] = updateButton(t, LOW, base);
    // 保持按住 50ms（跨过去抖窗口）
    evts[n++] = updateButton(t, LOW, base + DEBOUNCE_MS + 20);
    // 松开
    evts[n++] = updateButton(t, HIGH, base + DEBOUNCE_MS + 40);
    uint8_t got = 0; int cnt = 0;
    for (int k = 0; k < n; k++) if (evts[k]) { got = evts[k]; cnt++; }
    if (cnt == 1 && got == cases[i].code) {
      pass++;
      Serial.print("[TEST] PASS short ");
      Serial.print(cases[i].name);
      Serial.print(" -> 0x");
      Serial.println(got, HEX);
    } else {
      fail++;
      Serial.print("[TEST] FAIL short ");
      Serial.print(cases[i].name);
      Serial.print(" count=");
      Serial.print(cnt);
      Serial.print(" code=0x");
      Serial.println(got, HEX);
    }
  }

  // 用例 2：按钮3 长按（按住 1200ms 后松开）
  {
    Btn t = { 255, CODE_BTN3_SHORT, true, HIGH, 0, 0, 0, false };
    uint32_t base = 5000;
    uint8_t evts[8]; int n = 0;
    evts[n++] = updateButton(t, LOW, base);                       // 按下
    evts[n++] = updateButton(t, LOW, base + LONG_PRESS_MS + 50);   // 越过长按阈值
    evts[n++] = updateButton(t, LOW, base + LONG_PRESS_MS + 200);  // 继续按住
    evts[n++] = updateButton(t, HIGH, base + LONG_PRESS_MS + 400); // 松开
    uint8_t got = 0; int cnt = 0;
    for (int k = 0; k < n; k++) if (evts[k]) { got = evts[k]; cnt++; }
    if (cnt == 1 && got == CODE_BTN3_LONG) {
      pass++;
      Serial.println("[TEST] PASS long BTN3 -> 0x04 (single event)");
    } else {
      fail++;
      Serial.print("[TEST] FAIL long BTN3 count=");
      Serial.print(cnt);
      Serial.print(" code=0x");
      Serial.println(got, HEX);
    }
  }

  Serial.print("[TEST] timing self-test done pass=");
  Serial.print(pass);
  Serial.print(" fail=");
  Serial.println(fail);
  Serial.print("[TEST] RESULT ");
  Serial.println(fail == 0 ? "PASS" : "FAIL");
}

// ---------------- 串口调试命令 ----------------
void handleSerial() {
  static String line = "";
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (line.length()) {
        line.trim();
        if      (line == "n" || line == "N") simPress(CODE_BTN1_SHORT, "NEXT");
        else if (line == "o" || line == "O") simPress(CODE_BTN2_SHORT, "OK");
        else if (line == "f" || line == "F") simPress(CODE_BTN3_SHORT, "FINISH");
        else if (line == "l" || line == "L") simPress(CODE_BTN3_LONG, "FINISH-long");
        else if (line == "t" || line == "T") selfTestTiming();
        else if (line == "v" || line == "V") Serial.println("[VER] mcd_order_box v" FW_VERSION);
        else if (line == "i" || line == "I") printBanner();
        else if (line == "p" || line == "P") {
          Serial.print("[PIN] BTN1="); Serial.print(digitalRead(PIN_BTN1));
          Serial.print(" BTN2="); Serial.print(digitalRead(PIN_BTN2));
          Serial.print(" BTN3="); Serial.println(digitalRead(PIN_BTN3));
        }
        else if (line == "b" || line == "B") {
          Serial.println("[BOOT] reboot to BOOTSEL");
          delay(50);
          rp2040.rebootToBootloader();
        }
        else if (line == "h" || line == "H") {
          Serial.println("[HLP] n/o/f=BTN1/2/3短按 l=BTN3长按 t=时序自测 v=版本 p=引脚 b=BOOTSEL h=帮助");
        }
      }
      line = "";
    } else if (c >= 32) {
      line += c;
    }
  }
}

// ---------------- 生命周期 ----------------
void printBanner() {
  Serial.println("=== mcd_order_box v" FW_VERSION " (Beetle RP2350) ===");
  Serial.println("[READY]");
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BTN1, INPUT_PULLUP);
  pinMode(PIN_BTN2, INPUT_PULLUP);
  pinMode(PIN_BTN3, INPUT_PULLUP);
  pinMode(PIN_LED_ONBOARD, OUTPUT);
  usb_hid.setReportCallback(nullptr, onOutputReport);
  usb_hid.begin();
  printBanner();
}

void loop() {
  // 心跳（板载 LED 每 1s 翻转，证明程序在跑）
  static uint32_t lastBeat = 0;
  unsigned long now = millis();
  if (now - lastBeat >= 1000) {
    lastBeat = now;
    digitalWrite(PIN_LED_ONBOARD, !digitalRead(PIN_LED_ONBOARD));
  }

  handleButtons();
  handleSerial();
}
