# 🌉 Chat Bridge DeepSeek

این نسخه از `chat-bridge` فقط برای **DeepSeek** نوشته شده است. کارش این است که یک صفحهٔ گفتگوی مشخص DeepSeek را از طریق API محلی، شبیه API سازگار با OpenAI در اختیار DSH یا هر کلاینت دیگری بگذارد.
<img width="415" height="739" alt="image" src="https://github.com/user-attachments/assets/18545335-d7fd-4e0d-a6c8-d91e2952c8d1" />

## ایدهٔ کار

```text
DSH / OpenAI client
       │  POST /v1/chat/completions
       ▼
Bridge Server :20258
       │  WebSocket + extension token
       ▼
Chrome Extension
       │
       ├─ پیدا کردن یا باز کردن URL مشخص DeepSeek
       ├─ تزریق متن در textarea
       ├─ کلیک روی دکمهٔ ارسال
       └─ خواندن پاسخ (استریم SSE یا DOM)
       ▼
پاسخ JSON یا SSE به کلاینت
```

پاسخ از دو مسیر خوانده میشود: اولویت با **استریم واقعی SSE** است که `deepseek-stream-hook.js` در MAIN world رهگیری میکند (از نسخهٔ 0.4.0). اگر آن جواب نداد، پس از ۴ ثانیه به **selector پیام دستیار** در DOM برمیگردد. بنابراین هر دو مسیر به ساختار صفحهٔ DeepSeek وابستهاند، اما ارسال به یک URL مشخص مستقیم و قابلردیابی است.

## انتخاب گفتگو

دو راه وجود دارد:

### روش اول: URL را در هر درخواست بده

```json
{
  "model": "deepseek",
  "chat_url": "https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000000",
  "messages": [
    { "role": "user", "content": "سلام، خودت را معرفی کن." }
  ],
  "stream": false
}
```

اگر این URL از قبل در Chrome باز باشد، اکستنشن همان تب را استفاده میکند؛ در غیر این صورت تب را باز میکند.

فیلدهای `chatUrl`، `url` و `target_url` نیز بهعنوان alias پذیرفته میشوند، اما `chat_url` نام اصلی است.

### روش دوم: URL پیشفرض را یکبار تنظیم کن

```powershell
$key = '<کلیدی که با npm run key گرفتید>'
$body = @{
  url = 'https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000000'
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:20258/v1/chat/target' `
  -Method Post `
  -Headers @{ Authorization = "Bearer $key" } `
  -ContentType 'application/json' `
  -Body $body
```

این URL بهصورت محلی در `.chat-bridge-target.json` ذخیره میشود (فایل در `.gitignore` است) و بعد از ریاستارت سرور هم باقی میماند. اگر میخواهید هر درخواست URL مستقل داشته باشد، فیلد `chat_url` را در body هر درخواست بفرستید.

بعد از آن در درخواستهای معمولی DSH نیازی به فرستادن URL نیست:

```json
{
  "model": "deepseek",
  "messages": [
    { "role": "user", "content": "این گفتگو را ادامه بده." }
  ]
}
```

برای پاک کردن URL پیشفرض:

```powershell
Invoke-RestMethod `
  -Uri 'http://127.0.0.1:20258/v1/chat/target' `
  -Method Delete `
  -Headers @{ Authorization = "Bearer $key" }
```

## راهاندازی

### ۱) نصب و اجرای bridge

```powershell
cd C:\dev\porject1\chat-bridge-deepseek
npm.cmd install
npm.cmd start
```

این نسخه بهصورت پیشفرض روی پورت **۲۰۲۵۸** اجرا میشود تا با نسخهٔ اصلی تداخل نکند. پورت از متغیر `BRIDGE_PORT` خوانده میشود، اما برای تغییر آن باید ثابتهای `extension/background.js` و host permission/CSP در `extension/manifest.json` هم هماهنگ شوند.

کلید این نسخه در فایل مستقل `.chat-bridge-deepseek.key` ساخته میشود:

```powershell
npm.cmd run key
```

کلید در لاگ سرور چاپ نمیشود و داخل README یا اسکریپتها ذخیره نشده است.

### ۲) نصب اکستنشن

در Chrome به `chrome://extensions` بروید، Developer mode را روشن کنید و پوشهٔ زیر را Load unpacked کنید:

```text
C:\dev\porject1\chat-bridge-deepseek\extension
```

سپس یک گفتگوی DeepSeek را باز کنید و وارد حساب خود شوید. URLهای اشتراکی مثل `/a/chat/s/...` هم پذیرفته میشوند، چون در این نسخه URL صریحاً توسط کاربر انتخاب میشود.

### ۳) تست سریع API

```powershell
$key = '<کلید npm run key>'
$body = @{
  model = 'deepseek'
  chat_url = 'https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000000'
  stream = $false
  messages = @(
    @{ role = 'user'; content = 'سلام' }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:20258/v1/chat/completions' `
  -Method Post `
  -Headers @{ Authorization = "Bearer $key" } `
  -ContentType 'application/json' `
  -Body $body
```

## تنظیم DSH

بلوک پیشنهادی در `dsh-settings.snippet.yaml`:

```yaml
llm-pi-ai:
  providers:
    chat-bridge-deepseek:
      api: openai-completions
      baseURL: http://127.0.0.1:20258/v1
      apiKey: <CHAT-BRIDGE-KEY>
      models:
        - id: deepseek
          name: DeepSeek Browser Bridge
          contextWindow: 131072
          maxTokens: 16384
```

اگر DSH امکان ارسال فیلد اضافه در هر request را ندارد، ابتدا با `/v1/chat/target` یک URL پیشفرض تنظیم کنید.

## استریم واقعی (نسخهٔ ۰.۴.۰)

از نسخهٔ `0.4.0`، اکستنشن علاوه بر خواندن DOM، **جریان واقعی SSE دیپسیک** را هم رهگیری میکند.

### چه چیزی رهگیری میشود

فایل `extension/content/deepseek-stream-hook.js` در **MAIN world** و با `run_at: document_start` اجرا میشود و سه مسیر انتقال را patch میکند:

```text
window.fetch
XMLHttpRequest
window.EventSource
```

سپس فرمت SSE دیپسیک را تجزیه میکند:

| الگو | معنی |
|---|---|
| `data.v.response.fragments` | آرایهٔ fragment اولیه |
| `p=response/fragments`, `o=APPEND` | fragment جدید |
| `o=APPEND` + `p=response/fragments/N/content` | append متن به fragment N |
| `o=BATCH` + `p=response` | عملیات گروهی |
| `p=status` + `v=FINISHED` | **پایان قطعی پاسخ** |
| `choices[0].delta.content` | حالت سازگار با OpenAI |

نتیجه: اولین توکن بلافاصله به DSH میرسد و پایان پاسخ از روی خودِ پروتکل تشخیص داده میشود، نه با «چند ثانیه صبر کن تا متن ثابت شود».

> **یادداشت:** این قالب SSE از روی پروژهٔ مرجع پیادهسازی شده و هنوز روی ترافیک زنده DeepSeek تأیید نشده است. اگر DeepSeek قالب را تغییر دهد، پاسخ از مسیر DOM میآید و لاگ `hook_grace_expired` ظاهر میشود.

### سیاست پاکسازی DSML

چون tool call داخل همان جریان متنی میآید:

1. تا وقتی نشانهای از DSML دیده نشده، متن **زنده و تکهتکه** استریم میشود
2. بهمحض دیدن DSML، استریم متوقف و بافر میشود تا هیچ قطعهای از tool block نشت نکند
3. در پایان، تمام نواحی DSML حذف و فقط prose باقیمانده ارسال میشود
4. متن خام برای parse ابزار در driver حفظ میشود

اگر پاسخ **فقط tool call** باشد، پیام `open` باعث میشود driver بهاشتباه fallback به DOM نرود.

### fallback امن

اگر hook چیزی نگیرد (مثلاً تغییر transport در DeepSeek)، پس از ۴ ثانیه driver خودکار از مسیر DOM استفاده میکند.

برای دیدن وضعیت، در popup روی **«بررسی selector پاسخ»** بزنید؛ بخش `hook` وضعیت را نشان میدهد.

## Tool calling

نسخهٔ جدید ابزارهای OpenAI را از DSH عبور میدهد و DSML تولیدشده توسط DeepSeek را به `tool_calls` استاندارد تبدیل میکند:

```text
DSH tools → Bridge → prompt کنترلشده → DeepSeek
DSML → parser → tool_calls → DSH
DSH tool result → همان گفتگوی DeepSeek → پاسخ نهایی
```

- تعریف `tools` و `tool_choice` به اکستنشن منتقل میشود.
- DSML به `tool_calls` با `finish_reason: "tool_calls"` تبدیل میشود.
- اجرای ابزار در **DSH** انجام میشود؛ Bridge فرمان سیستمی را اجرا نمیکند.
- نتیجهٔ ابزار با `role: tool` به همان تب DeepSeek برگردانده میشود؛ برای جلوگیری از سنگینشدن صفحه، فقط نسخهٔ فشرده/محدودشدهٔ نتیجه به DeepSeek ارسال میشود و نسخهٔ کامل در DSH باقی میماند.
- اگر DeepSeek پاسخ را با `Stopped` یا `Server is temporarily unavailable` متوقف کند و دکمهٔ `Continue` نشان دهد، driver آن را قبل از ارسال prompt بعدی مدیریت میکند.
- نام ابزار باید در فهرست `tools` همان request وجود داشته باشد.

نمونهٔ حداقلی درخواست DSH:

```json
{
  "model": "deepseek",
  "messages": [{ "role": "user", "content": "پینگ بگیر" }],
  "tools": [{
    "type": "function",
    "function": {
      "name": "bash",
      "description": "اجرای فرمان",
      "parameters": {
        "type": "object",
        "properties": { "command": { "type": "string" } },
        "required": ["command"]
      }
    }
  }]
}
```

این قابلیت به رفتار داخلی مدل DeepSeek وابسته است؛ چون صفحهٔ وب API رسمی ابزار ندارد، manifest ابزارها بهصورت متن کنترلشده وارد گفتگو میشود و ممکن است در UI دیده شود. اگر مدل بهجای DSML متن عادی تولید کند، همان متن بهعنوان پاسخ متنی برگردانده میشود.

### تشخیص تأخیر

در نسخهٔ فعلی مراحل مهم با `[timing]` در لاگ سرور و اکستنشن ثبت میشوند:

```text
run_start
tab_ready
prompt_ready
input_ready
send_clicked
first_response
response_stable
response_collected
hook_stream_complete   (یا hook_grace_expired اگر hook پاسخ نداد)
driver_done
first_delta
done_received
```

با این لاگها میتوان فاصلهٔ زمان پاسخگیری DeepSeek، زمان انتظار driver و زمان انتقال به DSH را جدا دید.

## APIها

- `POST /v1/chat/completions` — ارسال پیام به گفتگوی DeepSeek انتخابشده
- `GET /v1/models` — مدلهای موجود
- `GET /health` — وضعیت bridge و اکستنشن
- `POST /v1/chat/target` — تنظیم URL پیشفرض (`/v1/chat/url` هم alias آن است)
- `GET /v1/chat/target` — خواندن URL پیشفرض
- `DELETE /v1/chat/target` — پاک کردن URL پیشفرض
- `POST /ext/register` — فقط برای اکستنشن؛ توکن کوتاهمدت WebSocket میدهد و کلید API را افشا نمیکند

فیلدهای درخواست completion:

- `model`: فعلاً فقط `deepseek` یا aliasهای آن
- `messages`: آرایهٔ پیامهای OpenAI
- `tools`: تعریف ابزارهای OpenAI
- `tool_choice`: `auto`، `none`، `required` یا انتخاب یک tool
- `chat_url`: URL اختیاری گفتگوی DeepSeek
- `stream`: boolean، پیشفرض `true`

## تست

```powershell
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:cancel
npm.cmd run test:tool
```

تست E2E فقط transport سرور و WebSocket را شبیهسازی میکند. تست واقعی DOM باید در Chrome و با حساب لاگینشدهٔ DeepSeek انجام شود.

## محدودیتهای فعلی

- selector اصلی پاسخ: `.ds-markdown.ds-assistant-message-main-content`
- selector باکس ورودی: `textarea[placeholder="Message DeepSeek"]`
- اگر DeepSeek کلاسها یا ساختار DOM را عوض کند، باید selectorهای `extension/content/driver.js` بهروزرسانی شوند.
- این نسخه عمداً از ChatGPT، Grok و Qwen پشتیبانی نمیکند.
- در مسیر استریم واقعی (hook)، متن بهصورت زنده به کلاینت میرسد. در مسیر DOM fallback، پاسخ پس از پایدار شدن کامل خوانده میشود و سپس به قطعات کوچک تقسیم میشود.
- قالب SSE دیپسیک هنوز روی ترافیک زنده تأیید نشده است (بخش استریم واقعی را ببینید).
- فایل کلید بهصورت محلی در `.chat-bridge-deepseek.key` نگهداری میشود؛ آن را commit یا به اشتراک نگذارید. URL پیشفرض گفتگو نیز فقط در فایل محلی و ignored با نام `.chat-bridge-target.json` نگهداری میشود.
