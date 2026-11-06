import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { planPage } from './plan-page';
import { timelineProps, ON } from './plan-gen';

// The Timeline card on Your path (the tax plan's E2, components/PlanTimeline.tsx):
// its points and rows, the empty state and its asks, the most a plan holds,
// Try it's gates, a copy and a refused plan, the notes each row keeps, and
// where focus goes. The item sheet is test/plan-item-sheet-view.test.tsx.

const page = await planPage();
const { dom, PLAN, settle, seedPlan, seedCopy, stored, writes, render, press, button, closeOf, fill, addTemplate, rest, answers } = page;
const { TimelineCard } = await import('@/components/PlanTimeline');
const { planOf } = await import('@/lib/fire/plan-v2');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { itemFromExpense, itemFromIncome, withItem, withoutItem } = await import('@/lib/fire/items');
const { EVENT_PART_TEXT } = await import('@/components/plan-scenario-text');
const { askAgesText } = await import('@/components/plan-text');
const { MASK, setAmountsHidden } = await import('@/lib/format');
type PlanItem = import('@/lib/fire/items').PlanItem;
type FirePlanV2 = import('@/lib/fire/plan-v2').FirePlanV2;

const mk = (id: string, kind: PlanItem['kind'], from: PlanItem['from'], set: Partial<PlanItem> = {}): PlanItem => ({
  id,
  label: id,
  kind,
  from,
  until: null,
  once: null,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: null,
  beforeTax: false,
  ...set,
});
const at = (age: number, offset = 0) => ({ anchor: { at: 'age' as const, age }, offset });
const on = (a: 'stop' | 'fi', offset = 0) => ({ anchor: { at: a }, offset });
const ROOF = itemFromExpense({ id: 'roof', label: 'Roof', amount: 30_000, atAge: 45 });
const SOCIAL = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replace(/\s+/g, ' ');
const card = (plan: FirePlanV2, over: Record<string, unknown> = {}) => renderToStaticMarkup(<TimelineCard {...timelineProps(plan, undefined, ON)} {...over} />);

describe('its points and rows', () => {
  const p: FirePlanV2 = {
    ...PLAN,
    partnerAge: 38,
    items: [
      SOCIAL,
      mk('Part-time work', 'part-time', on('stop'), { until: at(60), yearly: 20_000 }),
      ROOF,
      mk('Downshift', 'spending', { anchor: { at: 'balance', amount: 600_000 }, offset: 0 }, { yearly: -5_000 }),
      mk('Rent', 'other-income', { anchor: { at: 'item', id: 'Part-time work', edge: 'end' }, offset: 0 }, { yearly: 10_000 }),
      mk('Her pension', 'pension', at(67), { yearly: 12_000, owner: 'partner' }),
    ],
  };

  test('in order, a point holding items a heading over its own list, one with nothing a line of the same look', () => {
    const html = card(p);
    const heads = [...html.matchAll(/<(h4|p) class="section-label">(.*?)<\/\1>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, '').replace('&#x27;', "'")]);
    // Nothing today, so no point for it.
    expect(heads[0]).toEqual(['h4', 'At 45']);
    expect(heads.map(([, l]) => l).join(' | ')).toMatch(/^At 45 \| Invested assets reach \$600,000 · \d+ on your steady path \| FI around \d+ \| You stop at 55.* \| Part-time work ends at 60 \| At 67/);
    // The card's h3, each point's h4 under it, and none empty.
    expect(html).toContain('<h3 id="plan-timeline-title" tabindex="-1">Timeline</h3>');
    expect(html).not.toMatch(/<h4 class="section-label"><\/h4>/);
    // A point with no items is said, not headed.
    expect(heads.find(([, l]) => l.startsWith('FI around'))?.[0]).toBe('p');
    expect(heads.find(([, l]) => l === 'At 45')?.[0]).toBe('h4');
    const ages = heads.map(([, l]) => l);
    expect(ages.indexOf('At 45')).toBeLessThan(ages.findIndex((l) => l.startsWith('You stop at 55')));
    expect(ages.findIndex((l) => l.startsWith('You stop at 55'))).toBeLessThan(ages.findIndex((l) => l.startsWith('Part-time work ends at 60')));
  });

  test('a row: its title (whose, once a partner is set), its words, the amount and its line, and a chevron', () => {
    const html = card(p);
    const t = text(html);
    expect(t).toContain('Social Security, you');
    expect(t).toContain('Her pension, your partner');
    // A cost has no owner to name.
    expect(t).toContain('Roof Counts in your FI date $30,000 once');
    expect(html.match(/class="list-row"/g)?.length).toBe(6);
    expect(html.match(/<svg/g)?.length).toBe(6);
    // At 67 it starts long after FI, so it moves nothing there.
    expect(text(card({ ...PLAN, items: [SOCIAL] }))).toContain('Social Security For good $24,000 a year');
    expect(text(card({ ...PLAN, items: [SOCIAL] }))).not.toContain('Social Security, you');
  });

  test('the where line follows the plan’s start', () => {
    expect(text(card({ ...PLAN, items: [ROOF] }))).toContain('Will it last? counts costs, windfalls and income, from 55, where it starts.');
    expect(text(card({ ...PLAN, items: [ROOF], start: 'assets' }))).toContain('Will it last? counts costs, windfalls and income, from 40, where it starts.');
  });
});

describe('a row’s notes', () => {
  test('a life event’s keep their words, as a warning', () => {
    const before = mk('Child', 'child', at(38), { yearly: 15_000, until: { years: 18 } });
    const html = card({ ...PLAN, items: [before] });
    expect(html).toContain(`<span class="plan-warning">${EVENT_PART_TEXT.past}</span>`);
  });

  test('part-time before Will it last? starts: with what it replaces, its years before count in your FI date; without it, the caution says what to do', () => {
    const job = (replaces: number | null) => mk('Job', 'part-time', at(50), { until: at(60), yearly: 20_000, replaces });
    const said = text(card({ ...PLAN, items: [job(25_000)] }));
    expect(said).toContain('Its years before 55 count in your FI date, not in Will it last?, which starts at 55.');
    expect(said).not.toContain('Say what take-home it replaces');
    const unsaid = card({ ...PLAN, items: [job(null)] });
    expect(text(unsaid)).toContain('Say what take-home it replaces, so it counts in your FI date');
    expect(text(unsaid)).not.toContain('Its years before 55');
    expect(unsaid).toContain('notice caution');
  });

  test('income before FI given before tax says what rate it counts at, at caution', () => {
    const html = card({ ...PLAN, items: [mk('Rent', 'other-income', at(45), { yearly: 12_000, beforeTax: true })] });
    expect(text(html)).toContain('In your FI date after 0% tax, your plan’s rate on withdrawals. It may keep less: give its take-home for a closer date');
    expect(html).toContain('notice caution');
  });

  test('an item on FI or a balance starts where the steady path has it, in every run, and why', () => {
    const onFi = text(card({ ...PLAN, items: [mk('Trip', 'one-off', on('fi'), { once: 10_000 })] }));
    expect(onFi).toMatch(/Starts at \d+ in every run, as on your steady path: Will it last\? starts from your FI number, not your own path\./);
    const onBalance = text(card({ ...PLAN, start: 'custom', startBalance: 900_000, items: [mk('Trip', 'one-off', { anchor: { at: 'balance', amount: 700_000 }, offset: 0 }, { once: 10_000 })] }));
    expect(onBalance).toMatch(/Starts at \d+ in every run, as on your steady path: Will it last\? starts from the balance you typed, not your own path\./);
  });

  describe('two part-time jobs that meet on the steady path', () => {
    const job = (label: string, from: PlanItem['from'], until: PlanItem['until'], set: Partial<PlanItem> = {}) => mk(label, 'part-time', from, { until, yearly: 20_000, replaces: 30_000, ...set });
    const says = (other: string) => `<span class="plan-warning">It overlaps “${other}” on your steady path. Both count in those years. If one takes over from the other, start it when the other ends.</span>`;

    test('each row says so, naming the other', () => {
      const html = card({ ...PLAN, items: [job('Shop', at(41), at(90)), job('Consulting', on('fi', -1), at(90))] });
      expect(html).toContain(says('Consulting'));
      expect(html).toContain(says('Shop'));
    });

    test('nothing when one takes over from the other, for a partner’s, or for one running no years', () => {
      const shop = job('Shop', at(41), on('fi', -1));
      const plan = (b: PlanItem) => text(card({ ...PLAN, partnerAge: 40, items: [shop, b] }));
      expect(plan(job('Consulting', { anchor: { at: 'item', id: 'Shop', edge: 'end' }, offset: 0 }, at(90)))).not.toContain('It overlaps');
      expect(plan(job('Hers', at(42), at(90), { owner: 'partner' }))).not.toContain('It overlaps');
      // Its end on FI falls before its start, so the steady path has it run none.
      expect(plan(job('None', at(45), on('fi', -20)))).not.toContain('It overlaps');
    });

    test('nothing for years that count nowhere: all before today, or in neither the FI date nor Will it last?', () => {
      expect(text(card({ ...PLAN, items: [job('Over', at(30), at(38)), job('Now', at(36), on('fi', -1))] }))).not.toContain('It overlaps');
      const unsaid = { replaces: null };
      const neither = text(card({ ...PLAN, items: [job('Shop', at(41), on('fi', -1), unsaid), job('Gig', at(45), on('fi', -1), unsaid)] }));
      expect(neither).toContain('Say what take-home it replaces');
      expect(neither).not.toContain('It overlaps');
    });
  });

  test('a milestone never reached is last, with the nearest the steady path comes', () => {
    const html = card({ ...PLAN, items: [ROOF, mk('Yacht', 'one-off', { anchor: { at: 'balance', amount: 900_000_000 }, offset: 0 }, { once: 1_000 })] });
    const t = text(html);
    expect(t).toContain('Invested assets reach $900,000,000 · not by 95');
    expect(t).toMatch(/At most \$[\d,]+, at \d+\./);
    expect(t.indexOf('You stop at 55')).toBeLessThan(t.indexOf('not by 95'));
  });

  test('not placed yet, each with why', () => {
    const noAnswer: FirePlanV2 = { ...PLAN, stopAtFi: true, targetAge: null, savings: 0, assets: 1_000, spending: 90_000, items: [mk('Job', 'part-time', on('stop'), { until: at(60), yearly: 20_000 })] };
    const t = text(card(noAnswer));
    expect(t).toContain('Not placed yet');
    expect(t).toContain('Waits on your stop: no FI by 95, so nothing is simulated.');
    const noStop = text(card({ ...PLAN, targetAge: null, items: [mk('Job', 'part-time', on('stop'), { until: at(60), yearly: 20_000 })] }));
    expect(noStop).toContain('Waits on your stop: set it in Household.');
    const ends = text(card({ ...PLAN, items: [mk('Boat', 'one-off', { anchor: { at: 'balance', amount: 900_000_000 }, offset: 0 }, { once: 1_000 }), mk('Then', 'spending', { anchor: { at: 'item', id: 'Boat', edge: 'start' }, offset: 0 }, { yearly: 100 })] }));
    expect(ends).toContain('Waits on Boat, which never starts on your steady path.');
    const noYears = text(card({ ...PLAN, items: [mk('Short', 'spending', at(45), { yearly: 100, until: { anchor: { at: 'item', id: 'Later', edge: 'start' }, offset: 0 } }), mk('Later', 'spending', at(44), { yearly: 100 })] }));
    expect(noYears).toContain('Ends before it starts, so it runs no years.');
  });
});

describe('the empty state', () => {
  test('its title, line, five chips and Add; in a copy its line says so', () => {
    const html = card(PLAN);
    const t = text(html);
    expect(html).toContain('Nothing on your Timeline yet</h4>');
    expect(t).toContain('Add what you expect, or try it in a copy:');
    expect([...html.matchAll(/class="chip"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(['Social Security', 'Part-time work', 'Buy a home', 'A child', 'A cost']);
    expect(text(card(PLAN, { copyName: 'Stop at 52' }))).toContain('Add what you expect to this copy:');
  });

  test('with no age, the one button is the ask, and no chips', () => {
    const html = card({ ...PLAN, age: null });
    expect(text(html)).toContain('An item is placed by age. Add your age');
    expect(html).not.toContain('class="chip"');
  });

  test('with an age and no stop, Add works; and with items, the ask for the stop leads', () => {
    expect(card({ ...PLAN, targetAge: null })).toContain('class="chip"');
    const t = text(card({ ...PLAN, targetAge: null, items: [ROOF] }));
    expect(t).toContain('Add when you’d like to stop');
    expect(t).toContain('Timeline Add');
  });

  test('its ask opens Household; once the age is saved, focus goes to Add', async () => {
    await seedPlan({ ...PLAN, age: null, targetAge: null });
    const tab = await render();
    const ask = button(tab.timeline(), 'Add your age');
    await press(ask);
    const form = tab.dialog()!;
    expect(form.getAttribute('aria-label')).toBe('Household');
    await fill(form, 'Your age', '40');
    await press(button(form, 'Save'));
    await settle(400);
    expect(tab.timeline()!.textContent).toContain('Add what you expect');
    expect((dom.document.activeElement as { textContent: string }).textContent).toBe('Add');
    await tab.unmount();
  }, 20_000);
});

describe('the most a plan holds', () => {
  const full = Array.from({ length: 25 }, (_, i) => mk(`x${i}`, 'one-off', at(45), { once: 100 }));

  test('at 25 Add is off, and it says why', () => {
    const html = card({ ...PLAN, items: full });
    expect(text(html)).toContain('A plan holds up to 25 items: remove one to add another.');
    expect(html).toMatch(/<button type="button" class="btn ghost"[^>]*aria-disabled="true"/);
  });
});

describe('Try it’s gates', () => {
  const add = async (tab: Awaited<ReturnType<typeof render>>) => {
    const sheet = await addTemplate(tab, 'A cost');
    return sheet;
  };

  test('with the most plans kept: off, and why', async () => {
    await seedPlan();
    for (let i = 1; i < 11; i++) await seedCopy(`Copy ${i}`);
    const tab = await render();
    const sheet = await add(tab);
    expect(sheet.textContent).toContain('You have 11 plans, the most Nya keeps: delete one in Plans to try another.');
    expect(button(sheet, 'Try it in a copy')?.disabled).toBe(true);
    expect(button(sheet, 'Add to your plan')?.disabled).toBe(false);
    await tab.unmount();
  }, 30_000);

  test('with your plans not loaded: off, and why, with Try again', async () => {
    await seedPlan();
    answers['GET /api/plans'] = () => Response.json({ error: 'no' }, { status: 500 });
    const tab = await render();
    const sheet = await add(tab);
    expect(button(sheet, 'Try it in a copy')?.disabled).toBe(true);
    expect(button(sheet, 'Try again')).not.toBeNull();
    // Adding to your plan doesn't need them.
    expect(button(sheet, 'Add to your plan')?.disabled).toBe(false);
    await tab.unmount();
  }, 20_000);
});

describe('a copy open', () => {
  test('its words name the copy, and it has no Try it', async () => {
    await seedPlan();
    await seedCopy('Stop at 52', { targetAge: 52 });
    const tab = await render();
    await page.openCopy(tab, 'Stop at 52');
    expect(tab.timeline()!.textContent).toContain('Copy: Stop at 52');
    expect(tab.timeline()!.textContent).toContain('Add what you expect to this copy:');
    await press(tab.chip('A cost'));
    const sheet = tab.dialog()!;
    expect(button(sheet, 'Try it in a copy')).toBeNull();
    expect(button(sheet, 'Add to this copy')).not.toBeNull();
    expect(sheet.textContent).toContain('Saved to this copy, not your plan.');
    await tab.unmount();
  }, 20_000);

  test('Added to the copy, said on the copy’s card and gone with it', async () => {
    await seedPlan();
    await seedCopy('Stop at 52', { targetAge: 52 });
    const tab = await render();
    await page.openCopy(tab, 'Stop at 52');
    await press(tab.chip('A cost'));
    await fill(tab.dialog()!, 'The amount', '5000');
    await fill(tab.dialog()!, 'Starts at age', '45');
    await press(button(tab.dialog(), 'Add to this copy'));
    await settle(400);
    expect(tab.timeline()!.textContent).toContain('Added to Copy: Stop at 52');
    const back = tab.container.findAll((e) => e.getAttribute('aria-label') === 'Back to your plan')[0];
    await press(back);
    await settle(400);
    expect(tab.timeline()!.textContent).not.toContain('Added to Copy');
    await tab.unmount();
  }, 30_000);

  test('refused for lasting changes: its rows in one list, each opening to fix it, and nothing to add', () => {
    const below = mk('Mortgage', 'spending', at(41), { yearly: -45_000 });
    const html = card({ ...PLAN, items: [below] }, { refused: true, figures: null, copyName: 'Gone' });
    expect(text(html)).toContain('Mortgage');
    expect(html).not.toContain('class="btn ghost"');
    expect(html).not.toContain('class="chip"');
    expect(html).not.toContain('section-label');
  });
});

describe('rows open while the plan can’t be saved', () => {
  test('the sheet says why, Save is off, and nothing is sent', async () => {
    const saves: unknown[] = [];
    const paused = "Your saved plan couldn't be read, so this can't be saved yet: try again at the top of the Plan tab.";
    const { createRoot } = await import('react-dom/client');
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const props = {
      ...timelineProps({ ...PLAN, items: [ROOF] }, undefined, ON),
      editable: false,
      paused,
      onSave: async (next: unknown) => {
        saves.push(next);
        return true as boolean | string;
      },
    };
    await page.act(async () => root.render(<TimelineCard {...props} />));
    const row = host.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Roof'))[0];
    await press(row);
    const sheet = host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0];
    expect(sheet.textContent).toContain(paused);
    expect(button(sheet, 'Save')?.disabled).toBe(true);
    // Remove's row still opens its level, which says why, its button off.
    await press(sheet.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Remove from your plan'))[0]);
    const level = host.findAll((e) => e.getAttribute('role') === 'dialog' && e.getAttribute('data-open') === 'true')[0];
    expect(level.textContent).toContain(paused);
    expect(button(level, 'Remove')?.disabled).toBe(true);
    expect(saves).toEqual([]);
    await page.act(async () => root.unmount());
  });
});

describe('the answer’s notes for a plan whose only item is on the stop', () => {
  test('the retirement spending line stays', async () => {
    await seedPlan({ ...PLAN, items: [mk('rent', 'spending', on('stop'), { label: 'Rent paid', yearly: -6_000 })] });
    const tab = await render();
    expect(tab.text()).toContain('Spending in retirement');
    await tab.unmount();
  }, 20_000);
});

describe('where focus goes', () => {
  test('an ask gone from a Timeline with items: to the card’s Add', async () => {
    await seedPlan({ ...PLAN, targetAge: null, items: [mk('Roof', 'one-off', at(45), { once: 5_000 })] });
    const tab = await render();
    const ask = button(tab.timeline(), askAgesText('stop'));
    expect(ask).not.toBeNull();
    await page.act(async () => ask!.focus());
    await press(ask);
    await fill(tab.dialog()!, 'Stop age', '55');
    await press(button(tab.dialog(), 'Save'));
    await settle(400);
    expect(button(tab.timeline(), askAgesText('stop'))).toBeNull();
    expect(dom.document.activeElement).toBe(button(tab.timeline(), 'Add')!);
    await tab.unmount();
  }, 20_000);

  test('after the first Add, to the card’s Add; after another, to its row; after Remove, to the card', async () => {
    await seedPlan();
    const tab = await render();
    let sheet = await addTemplate(tab, 'A cost');
    await fill(sheet, 'The amount', '5000');
    await fill(sheet, 'Starts at age', '45');
    await press(button(sheet, 'Add to your plan'));
    await settle(400);
    expect(writes()).toEqual(['PUT /api/fire-plan']);
    expect(dom.document.activeElement).toBe(button(tab.timeline(), 'Add')!);

    sheet = await addTemplate(tab, 'A windfall');
    await fill(sheet, 'Amount, after tax', '9000');
    await fill(sheet, 'Starts at age', '47');
    await press(button(sheet, 'Add to your plan'));
    await settle(400);
    expect(dom.document.activeElement).toBe(tab.row('A windfall')!);
    expect((await stored()).byName['First plan'].plan.items.map((x) => x.label)).toEqual(['A cost', 'A windfall']);

    await press(tab.row('A windfall'));
    await press(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Remove from your plan'))[0]);
    await press(button(tab.dialog(), 'Remove'));
    await settle(400);
    expect(tab.row('A windfall')).toBeNull();
    const active = dom.document.activeElement as { textContent: string; tagName: string };
    expect(['Add', 'Timeline']).toContain(active.textContent);
    await tab.unmount();
  }, 30_000);

  test('closing Add leaves focus where it opened from; the back button says where it goes', async () => {
    await seedPlan({ ...PLAN, items: [ROOF] });
    const tab = await render();
    const add = button(tab.timeline(), 'Add')!;
    await page.act(async () => add.focus());
    await press(add);
    await press(tab.sheetRow('Buy a car'));
    const back = tab.dialog()!.findAll((e) => e.getAttribute('aria-label') === 'Back to Add to your Timeline');
    expect(back.length).toBe(1);
    await press(back[0]);
    expect(dom.document.activeElement).toBe(tab.sheetRow('Buy a car')!);
    await press(closeOf(tab.dialog()!));
    await settle(400);
    expect(dom.document.activeElement).toBe(add);
    await tab.unmount();
  }, 20_000);
});

describe('with amounts hidden', () => {
  test('a balance’s point and every row’s amount are masked', () => {
    setAmountsHidden(true);
    try {
      const html = card({ ...PLAN, items: [ROOF, mk('Downshift', 'spending', { anchor: { at: 'balance', amount: 600_000 }, offset: 0 }, { yearly: -5_000 })] });
      expect(html).not.toContain('$600,000');
      expect(html).not.toContain('$30,000');
      expect(html).not.toContain('$5,000');
      expect(html).toContain(MASK);
    } finally {
      setAmountsHidden(false);
    }
  });
});

describe('Remove sends no also', () => {
  test('a plan holding the same item keeps it', async () => {
    const mine = { ...PLAN, items: [ROOF] };
    await seedPlan(mine);
    await seedCopy('With roof', {}, mine);
    const tab = await render();
    await press(tab.row('Roof'));
    await press(tab.dialog()!.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Remove from your plan'))[0]);
    await press(button(tab.dialog(), 'Remove'));
    await settle(400);
    const { byName } = await stored();
    expect(byName['First plan'].plan.items).toEqual([]);
    expect(byName['With roof'].plan.items.map((x) => x.id)).toEqual(['roof']);
    await tab.unmount();
    await rest();
  }, 30_000);
});

// A plan's items written and read back through the plan-v2 reader, so every
// helper the card leans on is the store's.
describe('withItem and withoutItem', () => {
  test('replace by id, append, and remove', () => {
    const p = planOf({ ...DEFAULT_PLAN, age: 40 });
    const one = withItem(p, ROOF);
    expect(one.items.map((x) => x.id)).toEqual(['roof']);
    expect(withItem(one, { ...ROOF, once: 9 }).items.map((x) => x.once)).toEqual([9]);
    expect(withoutItem(one, 'roof').items).toEqual([]);
  });
});
