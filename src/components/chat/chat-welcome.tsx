import { CarWiseMark, ChatIcon, type ChatIconName } from './chat-icon';

const suggestions: { icon: ChatIconName; title: string; detail: string; text: string; tone: string }[] = [
  { icon: 'car', title: 'למצוא את הרכב שלי', detail: 'מה חשוב לך ברכב הבא?', text: 'איזה רכב הכי משתלם לי?', tone: 'teal' },
  { icon: 'wallet', title: 'להבין את הנטו', detail: 'לשאול את השאלות החשובות', text: 'כמה רכב חברה ישפיע לי על הנטו?', tone: 'peach' },
  { icon: 'compare', title: 'להשוות אפשרויות', detail: 'לסדר את ההתלבטות שלך', text: 'אני רוצה להשוות בין כמה רכבים', tone: 'blue' },
  { icon: 'shield', title: 'להכיר את הזכאות שלי', detail: 'להתחיל מהבסיס, בקצב שלך', text: 'אני רוצה להבין את הזכאות שלי', tone: 'purple' }
];

export function ChatWelcome({ onSuggest, disabled }: { onSuggest: (body: string) => void; disabled: boolean }) {
  return <section className="cw-welcome" aria-labelledby="cw-welcome-title">
    <div className="cw-journey-art" aria-hidden="true"><div className="cw-orbit cw-orbit-one" /><div className="cw-orbit cw-orbit-two" />
      <span className="cw-art-dot cw-art-dot-one" /><span className="cw-art-dot cw-art-dot-two" />
      <div className="cw-art-card"><CarWiseMark /><span>הדרך שלך. הבחירה שלך.</span><i /><svg viewBox="0 0 180 80" fill="none"><path d="M7 65h52c22 0 14-46 40-46h67" stroke="#a6dcd4" strokeWidth="15" strokeLinecap="round" /><path d="M7 65h52c22 0 14-46 40-46h67" stroke="#fff" strokeWidth="1.5" strokeDasharray="4 6" /><circle cx="166" cy="19" r="6" fill="#e88660" /></svg></div>
      <span className="cw-art-car"><ChatIcon name="car" /></span><span className="cw-art-spark"><ChatIcon name="spark" /></span>
    </div>
    <p className="cw-eyebrow"><span />קצת יותר בהירות. הרבה יותר ביטחון.</p>
    <h1 id="cw-welcome-title">הרכב הבא שלך.<br /><span>ההחלטה החכמה שלך.</span></h1>
    <p className="cw-welcome-copy">היי, נעים שאת כאן.<br className="cw-mobile-break" /> מה תרצי לדעת על רכב החברה שלך?</p>
    <div className="cw-suggestions">
      {suggestions.map(suggestion => <button key={suggestion.icon} className={`cw-suggestion cw-tone-${suggestion.tone}`} disabled={disabled} onClick={() => onSuggest(suggestion.text)}>
        <span className="cw-suggestion-icon"><ChatIcon name={suggestion.icon} /></span><strong>{suggestion.title}</strong><span className="cw-suggestion-detail">{suggestion.detail}</span><span className="cw-suggestion-arrow"><ChatIcon name="chevron" /></span>
      </button>)}
    </div>
    <p className="cw-welcome-note"><ChatIcon name="chat" />שיחה אישית: רכבים מקטלוג החברה, וחישוב ההשפעה על הנטו לפי פרטים שתאשרי.</p>
  </section>;
}
