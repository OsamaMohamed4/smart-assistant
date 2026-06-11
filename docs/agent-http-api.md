# Smart Assistant — Agent HTTP API

واجهة برمجية (HTTP API) للتكامل مع الـ AI Agent الخاص بكل شركة. تتيح لأي منصّة خارجية (مثل LoopChat لرسائل واتساب) إرسال رسالة العميل، واستقبال رد الـ Agent جاهز للعرض.

---

## 1) نقطة النهاية (Endpoint)

```
POST https://sermad.up.railway.app/api/v1/agent/chat
```

- **Content-Type:** `application/json`
- **Method:** `POST`

---

## 2) المصادقة (Authentication)

كل طلب يجب أن يحتوي على مفتاح API في الـ `Authorization` header:

```
Authorization: Bearer <AGENT_API_KEY>
```

> 💡 المفتاح يُسلَّم لكم خارج هذا المستند (لا يُذكر هنا لأسباب أمنية). احرصوا على تخزينه في متغيرات البيئة لا في الكود مباشرة.

طريقة بديلة (اختيارية):
```
X-Api-Key: <AGENT_API_KEY>
```

---

## 3) الـ Request Body

| الحقل | النوع | إلزامي | الوصف |
|---|---|---|---|
| `company_id` | string | ✅ | معرّف الشركة في منصّتنا (مثل `co-s00ylo`). نسلّمكم القيمة الصحيحة لكل عميل. |
| `customer_phone` | string | ✅ | رقم العميل بصيغة E.164 (مثل `+966501234567`). يُستخدم لاستمرارية المحادثة عبر الرسائل المتعددة. |
| `message` | string | ✅ | نص رسالة العميل. الحد الأقصى ٤٠٠٠ حرف. |
| `variables` | object | ⬜ | متغيّرات اختيارية لتمريرها للسيناريو (مثل اسم العميل). كل القيم نصوص. |

### مثال

```json
{
  "company_id": "co-s00ylo",
  "customer_phone": "+966501234567",
  "message": "السلام عليكم، أبغى أعرف أسعار الشقق",
  "variables": {
    "customer_name": "أحمد"
  }
}
```

---

## 4) الاستجابة (Response)

### نجاح — HTTP 200

```json
{
  "success": true,
  "reply": "وعليكم السلام أستاذ أحمد، أسعارنا تبدأ من خمسمائة ألف ريال. تحب أعرض لك المتاح حالياً؟",
  "chat_id": "chat_abc123",
  "company_id": "co-s00ylo",
  "latency_ms": 1240
}
```

| الحقل | الوصف |
|---|---|
| `success` | يكون `true` عند نجاح المعالجة. |
| `reply` | نص الرد الذي يجب إرساله للعميل عبر WhatsApp. |
| `chat_id` | معرّف المحادثة الداخلي. لا يحتاج تخزينه — منصّتنا تتذكّر المحادثة تلقائياً بواسطة `customer_phone`. |
| `latency_ms` | زمن المعالجة بالميلي ثانية (للمراقبة). |

### الأخطاء الشائعة

| الكود | السبب | المعالجة |
|---|---|---|
| **400** | حقل إلزامي مفقود أو غير صالح (`company_id`, `customer_phone`, `message`) | تحقّقوا من الـ payload |
| **401** | مفتاح API مفقود أو خطأ | راجعوا الـ Authorization header |
| **404** | الشركة غير موجودة في منصّتنا | تأكّدوا من قيمة `company_id` |
| **409** | الشركة غير منشورة على Vapi بعد | نتولّى النشر من جانبنا — أبلغونا |
| **413** | الرسالة أطول من ٤٠٠٠ حرف | قصّوا الرسالة |
| **502** | تعذّر الاتصال بمحرّك الـ Agent | أعيدوا المحاولة بعد ثانية |
| **503** | الـ API Key غير مهيّأ على السيرفر | أبلغونا فوراً |

كل استجابة خطأ تأتي بنفس الشكل:
```json
{ "success": false, "error": "وصف الخطأ" }
```

---

## 5) استمرارية المحادثة (Conversation Continuity)

منصّتنا تتذكّر تلقائياً كل محادثة بناءً على المفتاح `(company_id, customer_phone)`:

- الرسالة الأولى من عميل جديد → يبدأ من البداية.
- الرسالة الثانية والثالثة وهكذا → يكمل من حيث توقّفت المحادثة، مع الاحتفاظ بالسياق (اسم العميل، ميزانيته، اختياراته السابقة).

لا حاجة لإرسال أي بيانات إضافية للحفاظ على هذه الذاكرة — يكفي إرسال نفس `customer_phone` في كل مرة.

> ⚠️ إذا انقطعت المحادثة لأكثر من ٢٤ ساعة، الـ Agent سيبدأ من البداية تلقائياً.

---

## 6) أمثلة كاملة

### cURL

```bash
curl -X POST https://sermad.up.railway.app/api/v1/agent/chat \
  -H "Authorization: Bearer YOUR_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "company_id": "co-s00ylo",
    "customer_phone": "+966501234567",
    "message": "السلام عليكم"
  }'
```

### JavaScript (fetch)

```javascript
const response = await fetch(
  "https://sermad.up.railway.app/api/v1/agent/chat",
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.AGENT_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      company_id    : "co-s00ylo",
      customer_phone: "+966501234567",
      message       : userText,
    }),
  },
);

const data = await response.json();
if (data.success) {
  await sendWhatsAppMessage(customerPhone, data.reply);
} else {
  console.error("Agent error:", data.error);
}
```

### Python (requests)

```python
import os, requests

r = requests.post(
    "https://sermad.up.railway.app/api/v1/agent/chat",
    headers={
        "Authorization": f"Bearer {os.environ['AGENT_API_KEY']}",
        "Content-Type":  "application/json",
    },
    json={
        "company_id":     "co-s00ylo",
        "customer_phone": "+966501234567",
        "message":        user_text,
    },
    timeout=25,
)
data = r.json()
if data["success"]:
    send_whatsapp(customer_phone, data["reply"])
else:
    print("Agent error:", data["error"])
```

---

## 7) سير العمل المتوقّع (Recommended Flow)

```
1. عميل يرسل رسالة WhatsApp للرقم المرتبط بشركة معيّنة
        ↓
2. LoopChat يستقبلها ويعرف الشركة (company_id من جانبكم)
        ↓
3. LoopChat يرسل POST إلى /api/v1/agent/chat
        ↓
4. منصّتنا تستدعي Vapi /chat بنفس البرومبت والـ KB
        ↓
5. الرد يعود إلى LoopChat في حقل `reply`
        ↓
6. LoopChat يرسل النص نفسه للعميل عبر WhatsApp
```

---

## 8) قواعد التشغيل (Best Practices)

1. **الـ Timeout على جانبكم**: اضبطوا timeout عند ٢٥–٣٠ ثانية. الزمن المتوسّط للرد ١–٣ ثوانٍ.
2. **إعادة المحاولة**: عند خطأ 502 فقط، أعيدوا المحاولة مرة واحدة بعد ثانية. لا تكرّروا على 400/401/404.
3. **معدّل الإرسال**: لا ترسلوا أكثر من ١٠ طلبات في الثانية لنفس الشركة في الوقت الحالي. يمكن رفع الحد بالاتفاق.
4. **رسائل العميل المتتابعة**: إذا أرسل العميل عدة رسائل خلال ثوانٍ قليلة، اجمعوها وأرسلوها كرسالة واحدة لتجنّب ردود متشتّتة.
5. **رسائل الصوت (Voice Notes)**: حوّلوها إلى نص (Whisper API أو ما يماثله) ثم أرسلوها كنص عادي في `message`.

---

## 9) للدعم والتواصل

- لاستلام `AGENT_API_KEY` ولكل شركة `company_id` تخصّها.
- لرفع حدّ معدّل الإرسال أو طلب ميزات جديدة.
- لتقارير الأخطاء (مرفق رقم `chat_id` ووقت الحدث).

تواصلوا معنا عبر القنوات الرسمية للمنصّة.
