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
