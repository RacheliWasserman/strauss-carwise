import type { CalculationScenario, CatalogMessage } from '@/lib/catalog-message';
import { ChatIcon } from './chat-icon';

const shekels = (value: number) => `${Math.round(value).toLocaleString('he-IL')} ₪`;
const signed = (value: number) => {
  const rounded = Math.round(value);
  return rounded === 0 ? '0 ₪' : `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toLocaleString('he-IL')} ₪`;
};
const STATUS: Record<string, string> = { confirmed: 'מאושר', new: 'חדש', changed: 'עודכן', derived: 'נגזר' };

export function ApprovalSummary({ approval }: { approval: NonNullable<CatalogMessage['approval']> }) {
  return <section className="cw-approval" aria-label="סיכום פרטים לאישור" dir="rtl">
    <div className="cw-block-title"><ChatIcon name="shield" /><span>פרטים לאישור{approval.basedOnVersion ? ` · מבוסס על גרסה ${approval.basedOnVersion}` : ''}</span></div>
    <table className="cw-approval-table">
      <thead><tr><th scope="col">פרט</th><th scope="col">ערך</th><th scope="col">מקור</th></tr></thead>
      <tbody>{approval.rows.map(row => <tr key={row.label}>
        <th scope="row">{row.label}</th><td dir="auto">{row.value}</td>
        <td><span className={`cw-status cw-status-${row.status}`}>{STATUS[row.status]}</span></td>
      </tr>)}</tbody>
    </table>
    <p className="cw-block-caption">קוד הסיכום <bdi>{approval.code}</bdi>. האישור תקף רק לסיכום הזה; שינוי פרט יוצר סיכום חדש.</p>
  </section>;
}

function Scenario({ scenario }: { scenario: CalculationScenario }) {
  // The server stores whole shekels and the worksheet delta; the UI never recalculates.
  const delta = scenario.delta;
  const up = (delta ?? 0) >= 0;
  return <li className={`cw-calc-card ${scenario.eligible && scenario.net !== null ? '' : 'cw-calc-card-muted'}`}>
    <h3 dir="auto">{scenario.name}</h3>
    {(scenario.group_code || scenario.drive_type) && <p>{[scenario.group_code && `קבוצה ${scenario.group_code}`, scenario.drive_type].filter(Boolean).join(' · ')}</p>}
    {scenario.net !== null && delta !== null ? <>
      <strong className={up ? 'cw-delta-up' : 'cw-delta-down'} aria-label={`שינוי חודשי בנטו ${signed(delta)}`}>{signed(delta)}<small> בחודש</small></strong>
      <dl>
        <div><dt>נטו צפוי</dt><dd>{shekels(scenario.net)}</dd></div>
        {scenario.carValueOfUse !== null && scenario.carValueOfUse > 0 && <div><dt>שווי שימוש</dt><dd>{shekels(scenario.carValueOfUse)}</dd></div>}
        {scenario.participation !== null && scenario.participation > 0 && <div><dt>השתתפות</dt><dd>{shekels(scenario.participation)}</dd></div>}
        {scenario.electricGrossUp !== null && scenario.electricGrossUp > 0 && <div><dt>גילום חשמלי (ברוטו)</dt><dd>{shekels(scenario.electricGrossUp)}</dd></div>}
        {scenario.maintenance !== null && scenario.maintenance > 0 && <div><dt>אחזקה בוויתור (ברוטו)</dt><dd>{shekels(scenario.maintenance)}</dd></div>}
        {scenario.familyExtra !== null && scenario.familyExtra > 0 && <div><dt>תוספת מסלול משפחתי</dt><dd>{shekels(scenario.familyExtra)}</dd></div>}
      </dl>
    </> : <p className="cw-calc-reason">{scenario.reason}</p>}
  </li>;
}

export function CalculationResults({ calculation }: { calculation: NonNullable<CatalogMessage['calculation']> }) {
  const baseline = calculation.baseline;
  return <section className="cw-calc" aria-label="תוצאות חישוב נטו" dir="rtl">
    <div className="cw-block-title"><ChatIcon name="check" /><span>חישוב נטו חודשי · {baseline.name}{baseline.net !== null ? `: ${shekels(baseline.net)}` : ''}</span></div>
    <ul className="cw-calc-grid">{calculation.scenarios.map(scenario => <Scenario key={`${scenario.kind}:${scenario.vehicleId ?? 'waiver'}`} scenario={scenario} />)}</ul>
    <p className="cw-block-caption">מחשבון החברה · פרופיל גרסה {calculation.profileVersion} · כללים {calculation.rulesVersion} · שנת מס {calculation.taxYear}. {calculation.saved ? 'החישוב נשמר בהיסטוריה.' : 'החישוב לא נשמר בהיסטוריה.'} סימולציה ולא תלוש שכר רשמי.</p>
  </section>;
}

export function MessageActions({ actions, disabled, onAction }: {
  actions: NonNullable<CatalogMessage['actions']>; disabled: boolean; onAction: (body: string) => void;
}) {
  return <div className="cw-actions" role="group" aria-label="פעולות מוצעות">
    {actions.map(action => <button key={action.body} type="button" className={action.primary ? 'cw-action-primary' : ''}
      disabled={disabled} onClick={() => onAction(action.body)}>{action.label}</button>)}
  </div>;
}
