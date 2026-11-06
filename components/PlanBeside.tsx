// Two figures beside each other, under a heading each: your plan now and once tax is
// worked out, a conversion rule and none. A table, so a screen reader says which figure
// is which. Cells are strings, drawn through Masked, so hide amounts reaches them.

import { Masked } from './HideAmounts';

export function BesideTable({ caption, heads, rows }: { caption: string; heads: readonly [string, string]; rows: readonly (readonly [string, string, string])[] }) {
  return (
    <div className="plan-table-scroll">
      <table className="plan-compare-table plan-beside-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Figure</span>
            </th>
            <th scope="col">{heads[0]}</th>
            <th scope="col">{heads[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b]) => (
            <tr key={label}>
              <th scope="row">
                <Masked>{label}</Masked>
              </th>
              <td className="money">
                <Masked>{a}</Masked>
              </td>
              <td className="money">
                <Masked>{b}</Masked>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
