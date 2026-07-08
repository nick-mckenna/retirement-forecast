import { PERSON_IDS } from "../../model/preRetirementTypes";
import { usePreRetirementStore } from "../../store/preRetirementStore";
import { useStore } from "../../store/scenarioStore";

/** Dropdown tagging an expense/income line with one of the accounts from the
 *  pre-retirement registry (or nothing). On an expense line the money goes
 *  INTO the account; on an income line it is withdrawn FROM the account into
 *  the joint account. Tagged lines feed the pre-retirement forecast. */
export function AccountSelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const accounts = usePreRetirementStore((st) => st.data.accounts);
  const people = useStore((st) => st.scenarios.find((x) => x.id === st.activeId)!.people);
  const known = value == null || accounts.some((a) => a.id === value);
  const selected = accounts.find((a) => a.id === value);
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      style={{ width: 170 }}
      title={selected?.name ?? (value == null ? undefined : `(deleted account: ${value})`)}
    >
      <option value="">—</option>
      {PERSON_IDS.map((p) => (
        <optgroup key={p} label={people[p].name}>
          {accounts
            .filter((a) => a.owner === p)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </optgroup>
      ))}
      {!known && <option value={value!}>(deleted account: {value})</option>}
    </select>
  );
}
