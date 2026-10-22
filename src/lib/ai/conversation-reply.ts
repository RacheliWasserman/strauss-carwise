import { z } from 'zod';
import { decodeCatalogMessage } from '../catalog-message';
import type { ConversationMessageRow } from '../conversation-repository';

/** The model interprets language; facts and amounts in a follow-up come only from saved server replies. */
export const conversationActSchema = z.enum(['acknowledge', 'farewell', 'pause', 'clarify', 'explain', 'annual', 'alternatives', 'advice']);
export type ConversationAct = z.infer<typeof conversationActSchema>;

export function conversationReply(act: ConversationAct | undefined, history: ConversationMessageRow[], pendingLabel?: string): string {
  if (act === 'acknowledge') return 'בשמחה! אני כאן אם עולה עוד שאלה.';
  if (act === 'farewell') return 'להתראות! השיחה נשמרה, ואפשר לחזור אליה כשנוח.';
  if (act === 'pause') return 'בסדר גמור, נעצור כאן. אפשר לחזור לבחירה או לבדיקה הקודמת בהמשך.';

  // Ignore social interludes when finding the calculation / question being discussed.
  const previous = [...history].reverse().filter(message => message.sender_type === 'assistant')
    .map(message => decodeCatalogMessage(message.body)).find(message => message && (!message.purpose || message.purpose === 'catalog'));
  const calculation = previous?.calculation;
  const money = (value: number) => `${value.toLocaleString('he-IL', { maximumFractionDigits: 0 })} ₪`;
  if (act === 'annual') {
    if (!calculation) return 'עדיין אין בשיחה חישוב מאומת שאפשר להציג במונחים שנתיים. לאיזה רכב או מסלול התכוונת?';
    const rows = calculation.scenarios.filter(scenario => scenario.eligible && scenario.net !== null && scenario.delta !== null);
    if (!rows.length) return 'אין בחישוב האחרון תוצאה מלאה שאפשר להציג לשנה. צריך להשלים קודם את הנתונים החסרים.';
    return 'בהתבסס על החישוב האחרון, ובהנחה שכל חודש זהה:\n\n' + rows.map(scenario =>
      `${scenario.name}: נטו שנתי משוער ${money(scenario.net! * 12)}, והפרש שנתי לעומת המצב הקיים ${money(scenario.delta! * 12)}.`).join('\n') +
      '\n\nזו הכפלה של התוצאה החודשית בשנים־עשר חודשים, ולא חישוב מס שנתי או התחייבות לשכר בפועל.';
  }
  if (act === 'advice') return 'אפשר להשוות לפי נתוני הקטלוג וההשפעה על הנטו, בלי לנחש מאפיינים שלא מופיעים במערכת. מה חשוב יותר בהחלטה כרגע — ההשפעה על הנטו או סוג ההנעה?';
  if (calculation && (act === 'explain' || act === 'clarify')) {
    return 'החישוב האחרון משווה את החלופות למצב הקיים, באמצעות הנתונים שאושרו ומנוע החישוב של המערכת.\n\n' +
      calculation.scenarios.map(scenario => scenario.eligible && scenario.net !== null && scenario.delta !== null
        ? `${scenario.name}: נטו חודשי ${money(scenario.net)}, הפרש מהמצב הקיים ${money(scenario.delta)}. ${scenario.reason}`
        : `${scenario.name}: ${scenario.reason}`).join('\n') + '\n\nעל איזה חלק כדאי להתעכב?';
  }
  if (pendingLabel) return `כדי להמשיך את הבדיקה חסר כרגע הפרט: ${pendingLabel}. לא אניח עבורו ערך. אפשר למסור אותו, או לבקש בירור מנציג אם אינו ידוע.`;
  if (act === 'clarify' && previous?.cards.length) {
    const { filters, group } = previous.state;
    const criteria = [group ? `הקבוצה שנבדקה בשיחה היא ${group}, ולכן נכללו רק קבוצות מותרות` : '',
      filters.driveType ? `סוג ההנעה המבוקש הוא ${filters.driveType}` : '',
      filters.manufacturer ? `היצרן המבוקש הוא ${filters.manufacturer}` : '',
      filters.name ? `החיפוש הוא לפי ${filters.name}` : ''].filter(Boolean);
    return `הרכבים שהוצגו הם רשומות פעילות מקטלוג החברה${criteria.length ? ', ונבחרו לפי הבקשה: ' + criteria.join('; ') : ''}. זו התאמה לנתוני החיפוש, ולא קביעה שרכב מסוים עדיף בלי לדעת מה חשוב לך.`;
  }
  if (previous?.text) return `בהמשך למה שבדקנו:\n\n${previous.text.slice(0, 1500)}`;
  return 'אני כאן. על מה כדאי להתמקד או מה תרצו שאסביר?';
}
