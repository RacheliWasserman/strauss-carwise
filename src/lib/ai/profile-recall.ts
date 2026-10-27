import 'server-only';
import {z} from 'zod';
import type {AdvisorState} from './advisor-state';
import type {EmployeeDataVersionRow} from '../employee-data-repository';
import type {CatalogRow} from './vehicle-selection';

export const recallTopicSchema=z.enum(['profile','occupation','current_vehicle','conversation','financial']);
export type RecallTopic=z.infer<typeof recallTopicSchema>;
/** High-confidence personal questions outrank a model's generic catalog default. */
export function profileRecallTopic(text:string):RecallTopic|null {
  if (/(?:^|\s)(?:אם|אילו|נניח)(?:\s|$)/u.test(text)) return null;
  const question=/(?:^|[^\p{L}])(?:מה|איזה|אילו|זוכר|זוכרת|זוכרים|יודע|יודעת|ידוע|זכור|תציג|הצג|תראה|תראי)(?=$|[^\p{L}])/u.test(text);
  if (!question) return null;
  if (/(?:השכר שלי|נתוני השכר שלי|פרטי השכר שלי)/u.test(text)&&!/[0-9]|נטו|עלה|ירד|לתקן|לשנות|לעדכן/u.test(text)) return 'financial';
  if (/(?:^|[^\p{L}])(?:מה|איזה)(?=$|[^\p{L}]).*(?:תפקיד|מקצוע|עיסוק).*שלי/u.test(text)) return 'occupation';
  if (/(?:^|[^\p{L}])(?:איזה|מה)(?=$|[^\p{L}]).*(?:רכב).*(?:יש לי|שלי|הנוכחי|היום|עכשיו)/u.test(text)) return 'current_vehicle';
  if (/(?:^|[^\p{L}])(?:זוכר|זוכרת|זוכרים|מה)(?=$|[^\p{L}]).*(?:אמרתי|סיפרתי|ביקשתי)/u.test(text)) return 'conversation';
  if (/(?:פרטים שלי|הפרופיל שלי|יודע עליי|יודע עלי|יודעת עליי|יודעת עלי|ידוע עליי|ידוע עלי)/u.test(text)) return 'profile';
  return null;
}
const profileSchema=z.object({user_id:z.string().uuid(),status:z.literal('confirmed'),id:z.string().uuid(),version:z.number().int().positive(),
  confirmed_at:z.string().min(1),display_name:z.string().min(1),occupation_title:z.string().min(1),current_vehicle_id:z.string().min(1).nullable()});
const labels:Record<string,string>={base_salary:'שכר הבסיס',commissions:'עמלות',bonus:'בונוס',current_participation:'השתתפות ברכב',
  current_vehicle_id:'הרכב הנוכחי',employee_pension_percent:'הפרשה לפנסיה',employee_study_fund_percent:'קרן השתלמות',
  tax_credit_points:'נקודות זיכוי',eligible_children_count:'ילדים זכאים',display_name:'השם'};
/** A saved detail the employee asks about by name. */
export type RecallField='base_salary'|'commissions'|'bonus'|'eligible_children_count'|'current_vehicle_id'|'current_participation'|
  'occupation_title'|'tax_credit_points'|'employee_pension_percent'|'employee_study_fund_percent';
const RECALL_WORDS:Array<[RecallField,RegExp]>=[
  ['base_salary',/(?:השכר|המשכורת)\s+(?:שלי|השמור|המאושר)|(?:מה|כמה)\s+(?:ה)?(?:שכר|משכורת)|כמה\s+(?:אני\s+)?(?:מרוויח|מרוויחה)/u],
  ['commissions',/(?:מה|כמה)\s+(?:ה)?עמלות|העמלות\s+שלי/u],
  ['bonus',/(?:מה|כמה)\s+(?:ה)?בונוס|הבונוס\s+שלי/u],
  ['eligible_children_count',/כמה\s+ילדים|מספר\s+(?:ה)?ילדים/u],
  ['current_vehicle_id',/(?:איזה|איזו|מה)\s+(?:ה)?רכב\s+(?:יש\s+לי|שלי|הנוכחי|שיש\s+לי)|הרכב\s+(?:הנוכחי|שלי)\s+(?:הוא|שמור|רשום)/u],
  ['current_participation',/(?:כמה|מה)\s+(?:ה)?השתתפות|ההשתתפות\s+(?:החודשית\s+)?שלי/u],
  ['occupation_title',/(?:מה|איזה)\s+(?:ה)?(?:תפקיד|מקצוע|עיסוק)/u],
  ['tax_credit_points',/(?:כמה|מה)\s+נקודות\s+(?:ה)?זיכוי|נקודות\s+הזיכוי\s+שלי/u],
  ['employee_pension_percent',/(?:כמה|מה)\s+(?:ה)?(?:הפרשה|הפרשות)?\s*(?:ל)?פנסיה/u],
  ['employee_study_fund_percent',/(?:כמה|מה)\s+(?:ה)?(?:הפרשה\s+)?(?:ל)?קרן\s+(?:ה)?השתלמות/u]
];
/**
 * The saved details a message asks about, in the order asked ("אתה יודע מה השכר שלי, כמה ילדים יש לי ואיזה רכב יש לי
 * היום?" → salary, children, current car). Every part is answered; a what-if is not a question about saved details.
 */
export function profileRecallFields(text:string):RecallField[] {
  if (/(?:^|\s)(?:אם|אילו|נניח)(?:\s|$)/u.test(text)) return [];
  // "אני לא יודעת כמה ההפרשה לפנסיה, והזיכוי לא נכון" says a value is unknown or wrong: a correction, not a question.
  if (/(?:^|[^\p{L}])לא\s+(?:יודע|יודעת|זוכר|זוכרת|בטוח|בטוחה|נכון|נכונה|נכונים|נכונות|מדויק)(?=$|[^\p{L}])|טעות|לתקן|לעדכן|לשנות/u.test(text)) return [];
  // A question: "?", or "אתה יודע / זוכר", "תזכיר", "מה רשום".
  if (!/\?|(?:אתה|את|אתם)\s+(?:יודע|יודעת|יודעים|זוכר|זוכרת|זוכרים)|תזכיר|תזכירי|תגיד|תגידי|מה\s+(?:רשום|שמור)/u.test(text)) return [];
  return RECALL_WORDS.flatMap(([field,pattern])=>{const match=pattern.exec(text);return match?[{field,at:match.index}]:[];})
    .sort((a,b)=>a.at-b.at).map(item=>item.field);
}
const fieldLabels:Record<RecallField,string>={base_salary:'שכר בסיס חודשי ברוטו',commissions:'עמלות חודשיות',bonus:'בונוס חודשי',
  eligible_children_count:'ילדים עד גיל 23',current_vehicle_id:'הרכב הנוכחי',current_participation:'השתתפות חודשית ברכב',occupation_title:'תפקיד',
  tax_credit_points:'נקודות זיכוי',employee_pension_percent:'הפרשה לפנסיה',employee_study_fund_percent:'הפרשה לקרן השתלמות'};
/** The asked details from the latest APPROVED profile only (never values still waiting for approval). */
export async function recallFields(fields:RecallField[],userId:string,state:AdvisorState,deps:{
  confirmed:(user:string)=>Promise<EmployeeDataVersionRow|null>;catalogRows?:()=>Promise<CatalogRow[]>
}):Promise<string> {
  let profile:EmployeeDataVersionRow|null;
  try {
    profile=await deps.confirmed(userId);
    if (profile && (!profileSchema.safeParse(profile).success||profile.user_id!==userId)) throw new Error('Invalid profile scope');
  } catch {return 'לא הצלחתי לטעון את הפרטים המאושרים כרגע. לא אשלים פרטים מניחוש. אפשר לנסות שוב עוד מעט.';}
  if (!profile) return 'עדיין אין פרופיל שאושר ונשמר לחשבון שלך, ולכן אין לי פרטים שמורים להציג. אפשר למסור אותם כאן בשיחה.';
  let carName:string|undefined;
  if (fields.includes('current_vehicle_id')&&profile.current_vehicle_id) {
    try {carName=(await deps.catalogRows?.())?.find(row=>row.id===profile!.current_vehicle_id)?.display_name;} catch {/* Said without the name. */}
  }
  const shown=(field:RecallField)=>{
    if (field==='occupation_title') return profile!.occupation_title;
    if (field==='current_vehicle_id') return profile!.current_vehicle_id===null?'אין רכב צמוד':carName??'שמור, אבל שמו לא זמין לי כרגע';
    const value=Number(profile![field]);
    if (!Number.isFinite(value)) return 'לא רשום';
    if (['employee_pension_percent','employee_study_fund_percent'].includes(field)) return `${value.toLocaleString('he-IL')}%`;
    if (['eligible_children_count','tax_credit_points'].includes(field)) return value.toLocaleString('he-IL');
    return `${value.toLocaleString('he-IL')} ₪`;
  };
  const lines=fields.map(field=>`• ${fieldLabels[field]}: ${shown(field)}`);
  const waiting=state.pendingFacts.some(fact=>(fields as string[]).includes(fact.field)&&fact.value!==profile![fact.field]);
  return `כן. לפי הפרופיל המאושר שלך:\n${lines.join('\n')}${waiting?'\nבשיחה יש גם ערכים חדשים שעוד לא אישרת, והם לא מחליפים את הפרופיל עד האישור.':''}`;
}
export async function recallProfile(topic:RecallTopic,userId:string,state:AdvisorState,deps:{
  confirmed:(user:string)=>Promise<EmployeeDataVersionRow|null>;catalogRows?:()=>Promise<CatalogRow[]>
}):Promise<string> {
  let profile:EmployeeDataVersionRow|null;
  try {
    profile=await deps.confirmed(userId);
    if (profile && (!profileSchema.safeParse(profile).success||profile.user_id!==userId)) throw new Error('Invalid profile scope');
  } catch {return 'לא הצלחתי לטעון את הפרטים המאושרים כרגע. לא אשלים פרטים מניחוש. אפשר לנסות שוב עוד מעט; השיחה והבחירות שלך נשמרו.';}
  const parts:string[]=[];
  if (!profile) parts.push('עדיין אין פרופיל שאושר ונשמר לחשבון שלך. פרטים שנמסרו בשיחה אינם נחשבים לפרופיל מאושר.');
  else {
    if (topic==='profile') parts.push(`כן, יש פרופיל מאושר בשם ${profile.display_name}. התפקיד שנשמר הוא ${profile.occupation_title}.`);
    if (topic==='occupation') parts.push(`התפקיד בפרופיל המאושר האחרון שלך הוא ${profile.occupation_title}. זהו פרט שאושר בפרופיל, לא אימות רשמי של השיבוץ בחברה.`);
    if (topic==='profile'||topic==='current_vehicle') {
      if (profile.current_vehicle_id===null) parts.push('לא רשום רכב חברה נוכחי בפרופיל המאושר.');
      else {
        let name:string|undefined;
        try {name=(await deps.catalogRows?.())?.find(row=>row.id===profile!.current_vehicle_id)?.display_name;} catch {/* Do not guess a model from the conversation. */}
        parts.push(name?`הרכב הנוכחי שנשמר הוא ${name}.`:'שמור רכב נוכחי בפרופיל, אבל שמו לא זמין לי כעת. לא אנחש לפי רכבים שעלו בשיחה.');
      }
    }
    if (topic==='financial') {
      const values=(['base_salary','commissions','bonus','current_participation'] as const).flatMap(field=>{
        const value=profile![field];
        return typeof value==='number'&&Number.isFinite(value)?[`${labels[field]}: ${value.toLocaleString('he-IL')} ₪`]:[];
      });
      parts.push(values.length?`אלה הנתונים שנשמרו בפרופיל המאושר, ללא חישוב חדש: ${values.join('; ')}.`:'פרטי השכר המאושרים אינם זמינים להצגה כרגע.');
    } else if (topic==='profile') parts.push('פרטי השכר אינם מוצגים כאן מטעמי פרטיות; אפשר לבקש להציג אותם.');
  }
  if (topic==='conversation') {
    const goals:Record<AdvisorState['goal'],string>={catalog:'חיפוש רכבים',recommendation:'בחירת רכב',comparison:'השוואת רכבים',net:'בדיקת השפעה על הנטו',waiver:'בדיקת ויתור על רכב',family:'בדיקת המסלול המשפחתי',help:'בירור אפשרויות'};
    const preferences=Object.values(state.preferences).filter(Boolean).join(', ');
    parts.push(`בהקשר השיחה שמורה בקשה ל${goals[state.goal]}${preferences?`, עם ההעדפות: ${preferences}`:''}. זהו הקשר שיחה ולא אישור של פרטים אישיים.`);
  }
  const pending=[...new Set(state.pendingFacts.filter(fact=>!profile||fact.value!==profile[fact.field]).map(fact=>labels[fact.field]??'פרט אישי'))];
  if (state.occupation?.match && state.occupation.match.title!==profile?.occupation_title) pending.push('התפקיד שנמסר בשיחה');
  if (pending.length) parts.push(`יש גם פרטים שטרם אושרו: ${pending.join(', ')}. הם אינם מחליפים את הפרופיל המאושר.`);
  if (!profile&&!pending.length&&topic!=='conversation') parts.push('אפשר להמשיך מהשיחה הקיימת ולהשלים פרטים כשיהיה צורך.');
  return parts.join('\n\n');
}
