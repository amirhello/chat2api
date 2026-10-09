# راهنمای Chat Bridge DeepSeek

این نسخه فقط برای استفاده از یک گفتگوی مشخص DeepSeek ساخته شده است. اگر URL گفتگو را بدهید، اکستنشن همان URL را باز یا پیدا میکند و پیام را در همان صفحه ارسال میکند.

## ۱) سرور

```powershell
cd C:\dev\porject1\chat-bridge-deepseek
npm.cmd start
```

پورت پیشفرض این نسخه `20258` است تا با نسخهٔ اصلی پروژه تضاد نداشته باشد.

بررسی سلامت:

```powershell
Invoke-RestMethod http://127.0.0.1:20258/health
```

## ۲) اکستنشن

در `chrome://extensions`، گزینهٔ Developer mode را روشن کنید و این پوشه را Load unpacked کنید:

```text
C:\dev\porject1\chat-bridge-deepseek\extension
```

در popup میتوانید URL گفتگو را وارد و تب را باز کنید. اگر bridge متصل باشد، همان URL بهعنوان target پیشفرض سرور هم اعمال میشود. اکستنشن باید روی `chat.deepseek.com` اجرا شود و صفحه باید وارد حساب کاربری باشد.

## ۳) گرفتن کلید

```powershell
npm.cmd run key
```

این دستور فایل `bridge/print-key.js` را اجرا میکند و کلید را از `.chat-bridge-deepseek.key` چاپ میکند. کلید را در README، اسکریپت یا commit قرار ندهید.

## ۴) تنظیم یکبارهٔ گفتگو

اگر میخواهید DSH هر بار URL را نفرستد، این درخواست را یکبار اجرا کنید:

```powershell
$key = '<کلید شما>'
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

از این به بعد درخواستهای `/v1/chat/completions` بهصورت پیشفرض روی همان گفتگو اجرا میشوند.

## ۵) تست مستقیم

```powershell
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

پاسخ باید در `choices[0].message.content` باشد.

## Tool calling

در این نسخه، `tools` و `tool_choice` از DSH عبور میکنند. اگر DeepSeek پاسخ DSML تولید کند، Bridge آن را به `tool_calls` استاندارد تبدیل میکند و DSH میتواند ابزار را اجرا کند.

```text
DSH → tools → Bridge → DeepSeek
DeepSeek DSML → tool_calls → DSH
DSH tool result → همان گفتگو → پاسخ نهایی
```

- ابزار در Bridge اجرا نمیشود؛ اجرای واقعی در DSH است.
- فقط نامهایی که در `tools` همان درخواست آمدهاند بهعنوان tool call معتبر پذیرفته میشوند.
- نتیجهٔ ابزار بهصورت فشرده برای صفحهٔ DeepSeek ارسال میشود؛ نسخهٔ کامل همچنان در DSH باقی میماند.
- اگر DeepSeek پاسخ را متوقف کرده و دکمهٔ Continue نشان میدهد، driver قبل از prompt بعدی آن را مدیریت میکند.
- اگر مدل DSML تولید نکند، پاسخ بهصورت متن عادی برگردانده میشود.
- چون صفحهٔ وب DeepSeek ابزار رسمی ندارد، توضیح ابزارها بهصورت متن کنترلشده وارد گفتگو میشود و ممکن است در UI قابل مشاهده باشد.
- برای شروع تست، ابزار بیخطر مثل `echo` یا `get_time` مناسبتر از `bash` است.

## تنظیم DSH

از فایل `dsh-settings.snippet.yaml` استفاده کنید:

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

## استریم واقعی و عیبیابی آن

در نسخهٔ `0.4.0` استریم واقعی SSE فعال است و اولین توکن معمولاً بلافاصله میرسد. قالب SSE دیپسیک هنوز روی ترافیک زنده تأیید نشده است.

در لاگ سرور و Console اکستنشن این خطوط را ببینید:

- `hook_stream_complete` → پاسخ از مسیر استریم واقعی آمد
- `hook_grace_expired` → hook چیزی نگرفت و مسیر DOM استفاده شد
- `first_delta` و `done_received` → زمانبندی سمت سرور
- `driver_done` → پایان کار driver برای این درخواست

اگر همیشه `hook_grace_expired` میبینید، یعنی DeepSeek قالب SSE را عوض کرده و باید الگوی parsing در `extension/content/deepseek-stream-hook.js` بهروز شود. در آن حالت پروژه همچنان کار میکند، فقط مسیر DOM استفاده میشود.

برای بررسی وضعیت hook، در popup روی **«بررسی selector پاسخ»** بزنید؛ بخش `hook` را ببینید.

## عیبیابی

### popup روی قطع میماند

- آیا سرور نسخهٔ جدید روی پورت 20258 اجرا شده است؟
- آیا همین پوشهٔ `chat-bridge-deepseek/extension` در Chrome بارگذاری شده است؟
- آیا نسخهٔ قدیمی اکستنشن روی همان مرورگر باقی مانده است؟ آن را غیرفعال یا reload کنید.

### باکس ورودی پیدا نمیشود

- ابتدا در خود Chrome وارد DeepSeek شوید.
- صفحه را refresh کنید.
- selector فعلی `textarea[placeholder="Message DeepSeek"]` است؛ اگر DeepSeek آن را عوض کرده، `extension/content/driver.js` را تغییر دهید.

### پاسخ خوانده نمیشود

- selector فعلی پاسخ `.ds-markdown.ds-assistant-message-main-content` است.
- چند ثانیه بعد از ارسال صبر کنید تا پاسخ کامل شود.
- اگر پاسخ خالی یا timeout شد، Console تب DeepSeek و لاگ سرور را بررسی کنید.

### درخواست به گفتگوی دیگری میرود

- `/v1/chat/target` را با URL موردنظر دوباره تنظیم کنید.
- اگر چند تب با URL مشابه دارید، popup باید همان URL را نشان دهد.
- در صورت وجود URL پیشفرض، فیلد `chat_url` هر request اولویت دارد.

### پاسخ دیر میآید

در لاگ سرور و console اکستنشن، خطوط `[timing]` را دنبال کنید. `first_response` زمان شروع پاسخ DeepSeek و `done_received` زمان پایان انتقال به DSH را نشان میدهد.

## تست توسعه

```powershell
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:cancel
npm.cmd run test:tool
```

تست دوم فقط سرور/WebSocket را شبیهسازی میکند و جای تست واقعی صفحهٔ DeepSeek را نمیگیرد. تست سوم قطع اتصال و آزاد شدن صف را بررسی میکند.
