// Turn a WhatsApp media message into text the assistant can read.
//
// The reply pipeline (server.js askGPT) takes a plain text string, so a voice
// note, a video or an image is first reduced to text here and then handled
// exactly like a typed message -- same scenario, same knowledge base, same
// tools. Nothing provider-specific lives here: the caller hands in the file's
// bytes and MIME type, this returns { text }.
//
//   - audio (voice notes) and video  -> transcribed with OpenAI's audio API.
//     The transcription endpoint accepts ogg/oga/m4a/mp3/wav/webm AND mp4, so
//     a WhatsApp video (mp4) is transcribed for its spoken words directly, no
//     ffmpeg needed. Visual-only content of a video is not read.
//   - image                           -> described (and any visible text read)
//     by the vision model.
//
// Models are env-switchable. Defaults are safe, widely-available choices:
//   MEDIA_TRANSCRIBE_MODEL  default 'whisper-1'   (also: 'gpt-4o-transcribe')
//   MEDIA_VISION_MODEL      default 'gpt-4o'      (any vision-capable model)
require('dotenv').config();
const OpenAI = require('openai');
const { toFile } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 1 });

const TRANSCRIBE_MODEL = process.env.MEDIA_TRANSCRIBE_MODEL || 'whisper-1';
const VISION_MODEL     = process.env.MEDIA_VISION_MODEL || 'gpt-4o';

// Hard caps so a huge upload can't run away with cost or memory.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;   // OpenAI's own transcription limit
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_OUT    = 4000;               // matches the text message cap

// What kind of media a message is, from its MIME type (and a hint when the
// provider only gives a coarse type like 'audio'/'video'/'image').
function mediaKind(mime, hint) {
  const m = String(mime || '').toLowerCase();
  const h = String(hint || '').toLowerCase();
  if (m.startsWith('audio/') || h === 'audio' || h === 'voice') return 'audio';
  if (m.startsWith('video/') || h === 'video') return 'video';
  if (m.startsWith('image/') || h === 'image' || h === 'photo') return 'image';
  // Some providers send voice notes as application/ogg.
  if (m.includes('ogg')) return 'audio';
  return null;
}

// A filename with an extension the transcription API recognises. WhatsApp
// voice notes are ogg/opus; videos are mp4.
function audioFilename(mime, kind) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || kind === 'video') return 'media.mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return 'media.mp3';
  if (m.includes('wav')) return 'media.wav';
  if (m.includes('webm')) return 'media.webm';
  if (m.includes('m4a') || m.includes('x-m4a')) return 'media.m4a';
  return 'media.ogg';   // ogg/opus — the WhatsApp voice-note default
}

async function transcribe(buffer, mime, kind) {
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { error: 'الملف الصوتي أكبر من الحد المسموح للتفريغ (25 ميجابايت).' };
  }
  const file = await toFile(buffer, audioFilename(mime, kind));
  const r = await openai.audio.transcriptions.create({
    file,
    model: TRANSCRIBE_MODEL,
    language: 'ar',                 // Saudi customers; Whisper still handles other langs
  });
  const text = String(r?.text || '').trim().slice(0, MAX_TEXT_OUT);
  if (!text) return { error: 'لم يُستخرج كلام من المقطع.' };
  return { text };
}

async function describeImage(buffer, mime) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { error: 'الصورة أكبر من الحد المسموح.' };
  }
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  const r = await openai.chat.completions.create({
    model: VISION_MODEL,
    max_tokens: 500,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'صف محتوى هذه الصورة بإيجاز بالعربية، واذكر أي نص ظاهر فيها حرفياً (أرقام، أسماء، مبالغ). إن كانت إيصالاً أو مستنداً فانقل أهم بياناته.' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  });
  const text = String(r?.choices?.[0]?.message?.content || '').trim().slice(0, MAX_TEXT_OUT);
  if (!text) return { error: 'تعذّر وصف الصورة.' };
  return { text };
}

/**
 * Reduce one media file to text.
 *   buffer   Buffer of the downloaded file
 *   mime     its MIME type (e.g. 'audio/ogg', 'video/mp4', 'image/jpeg')
 *   hint     the provider's coarse message type, when MIME is missing
 * Returns { kind, text } on success, or { kind, error } with an Arabic reason.
 * Throws only on an unexpected provider/model failure, which the caller logs.
 */
async function understand({ buffer, mime, hint } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { kind: null, error: 'لا يوجد ملف.' };
  const kind = mediaKind(mime, hint);
  if (!kind) return { kind: null, error: 'نوع وسائط غير مدعوم.' };
  if (kind === 'audio' || kind === 'video') {
    return { kind, ...(await transcribe(buffer, mime, kind)) };
  }
  return { kind, ...(await describeImage(buffer, mime)) };
}

module.exports = { understand, mediaKind, TRANSCRIBE_MODEL, VISION_MODEL };
