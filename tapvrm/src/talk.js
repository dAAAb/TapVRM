// What the avatar says, and when. Edit LINES freely — one line is picked at random per situation.
export const LINES = {
  hello:   ['嗨！我感覺得到這台 MacBook 喔，敲敲看！', '感測器連上了！來拍我一下吧～'],
  strong:  ['哇靠！被重拍了！', '好痛！下手也太重了吧！', '哇啊——整台都在晃！', '喂！我會散掉啦！'],
  medium:  ['嘿！有人敲我？', '咚咚，是誰啊？', '欸，我感覺到了喔！'],
  light:   ['喔喔～被輕輕拍！', '嘿嘿，好癢～', '輕輕的，好舒服～', '是在叫我嗎？'],
  combo:   ['連打？！別再拍了啦！', '等等等等，一直拍是怎樣！', '你是在打鼓嗎？！'],
  tilt:    ['啊～歪歪的快要站不穩了', '哇哇，地板在斜耶！', '要滑下去了啦～'],
  tiltBig: ['救命！快要倒了！', '太斜了太斜了！'],
  level:   ['呼～終於站穩了', '好，回到水平了'],
  lidLow:  ['好暗喔…要睡了嗎？', '螢幕要闔起來了？晚安…'],
  lidOpen: ['哇，又亮了！早安！', '你回來啦！'],
  typing:  ['你在打字嗎？桌子一直在抖耶', '噠噠噠噠…打字好認真喔'],
  bored:   ['好無聊喔…敲我一下嘛', '還在嗎？拍拍我呀～'],
};

// Seconds before the same situation may speak again.
const COOLDOWN = {
  hello: 1e9, strong: 1.2, medium: 1.2, light: 1.2, combo: 4, tilt: 8, tiltBig: 6,
  level: 6, lidLow: 20, lidOpen: 20, typing: 60, bored: 50,
};
// Taps interrupt anything; ambient remarks wait for silence.
const URGENT = new Set(['strong', 'medium', 'light', 'combo', 'tiltBig']);

export function createTalker({ bubble, isOn, wantsVoice, onSpeak, serverVoice }) {
  let lineId = 0;
  const lastAt = {}, lastLine = {};
  let speakingUntil = 0, voice = null, speaking = false, quietSince = performance.now();

  const pickVoice = () => {
    const vs = speechSynthesis?.getVoices?.() || [];
    voice = vs.find(v => /zh[-_]TW/i.test(v.lang) && /Meijia|美佳/.test(v.name))
      || vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || null;
  };
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function say(kind) {
    if (!isOn()) return false;
    const now = performance.now() / 1000;
    if (now - (lastAt[kind] ?? -1e9) < COOLDOWN[kind]) return false;
    const urgent = URGENT.has(kind);
    if (!urgent && (now < speakingUntil + 2.5)) return false;
    const options = LINES[kind]; if (!options?.length) return false;
    let text = options[Math.floor(Math.random() * options.length)];
    if (options.length > 1 && text === lastLine[kind]) text = options[(options.indexOf(text) + 1) % options.length];
    lastAt[kind] = now; lastLine[kind] = text;

    bubble.textContent = text;
    bubble.classList.remove('show'); void bubble.offsetWidth; bubble.classList.add('show');
    const est = 0.9 + text.length * 0.2;
    speakingUntil = now + est;
    speaking = true;
    onSpeak?.(kind, text);

    const id = ++lineId;
    const done = () => { if (id === lineId) speakingUntil = Math.min(speakingUntil, performance.now() / 1000 + 0.15); };
    if (wantsVoice() && serverVoice?.()) {
      // macOS `say` on the local server: works in any browser, no click needed.
      speakingUntil = now + est * 2; // until the server says it finished
      fetch('/api/say', { method: 'POST', headers: { 'X-TapVRM': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(r => { if (!r.ok) throw 0; done(); })
        .catch(() => { if (id === lineId) speakingUntil = now + est; });
    } else if (wantsVoice() && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'zh-TW'; u.rate = 1.12; u.pitch = 1.35;
      u.onend = u.onerror = () => { speakingUntil = Math.min(speakingUntil, performance.now() / 1000 + 0.2); };
      speechSynthesis.speak(u);
    }
    return true;
  }

  // 0..1 mouth opening for lip flap while the line is "spoken"
  function mouth(t) {
    const now = performance.now() / 1000;
    if (now > speakingUntil) {
      if (speaking) { speaking = false; quietSince = performance.now(); setTimeout(() => { if (performance.now() / 1000 > speakingUntil) bubble.classList.remove('show'); }, 1200); }
      return 0;
    }
    return Math.max(0, 0.15 + 0.55 * Math.abs(Math.sin(t * 17)) * (0.6 + 0.4 * Math.sin(t * 5.3)));
  }

  return { say, mouth, isSpeaking: () => performance.now() / 1000 < speakingUntil, quietFor: () => (performance.now() - quietSince) / 1000 };
}
