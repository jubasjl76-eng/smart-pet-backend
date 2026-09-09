/**
 * Generated sale paperwork — contract, deposit receipt, health guarantee and
 * the microchip hand-off record. Pure: the route resolves a template (built-in
 * default, or the kennel's edited override), gathers tokens, and calls
 * `buildDoc` to get the finished text + the `documents.kind` to file it under.
 *
 * Templates are plain text with `{{token}}` placeholders. No em-dashes: this
 * text goes to buyers.
 */

export interface DocTemplate {
  slug: string;
  title: string;
  kind: string; // documents.kind
  body: string;
}

const CONTRACT = `PUPPY SALE AGREEMENT

Date: {{today}}
Breeder: {{kennel_name}}
Buyer: {{buyer_name}}

This agreement covers the sale of one {{breed}} puppy:

  Name: {{puppy_name}}
  Sex: {{puppy_sex}}
  Colour: {{puppy_color}}
  Date of birth: {{birth_date}}
  Microchip: {{microchip}}
  Sire: {{sire_name}}
  Dam: {{dam_name}}

Price: {{price}}
Deposit received: {{deposit}}
Balance due on collection: {{balance}}
Earliest collection date: {{go_home_on}}

The breeder confirms the puppy is in good health at the time of sale and has
received age appropriate worming and vaccination as recorded in the puppy pack.
The buyer agrees to provide suitable care, routine veterinary attention, and to
contact the breeder first if they can no longer keep the dog.

Breeder signature: ......................................  Date: ..............

Buyer signature: ........................................  Date: ..............
`;

const DEPOSIT_RECEIPT = `DEPOSIT RECEIPT

Date: {{today}}
From: {{buyer_name}}
To: {{kennel_name}}

Received with thanks a deposit of {{deposit}} to reserve one {{breed}} puppy,
"{{puppy_name}}".

Balance due on collection: {{balance}}

The deposit holds this puppy for the buyer. It is set against the final price
and is returned in full if the breeder cannot supply the puppy.

Received by: ............................................
`;

const HEALTH_GUARANTEE = `HEALTH GUARANTEE

Date: {{today}}
Breeder: {{kennel_name}}
Buyer: {{buyer_name}}

Puppy: {{puppy_name}} ({{breed}}), born {{birth_date}}, microchip {{microchip}}.

The breeder guarantees this puppy against life limiting hereditary defects for
twelve months from the date of birth. If a licensed veterinarian diagnoses such
a defect within that period, and it is confirmed in writing, the breeder will
replace the puppy or refund the price, at the buyer's choice, on return of this
document.

This guarantee does not cover injury, neglect, infectious disease contracted
after collection, or conditions caused by the puppy being overweight or
under exercised.

Breeder signature: ......................................  Date: ..............
`;

const MICROCHIP_HANDOFF = `MICROCHIP KEEPER TRANSFER

Date: {{today}}
Puppy: {{puppy_name}} ({{breed}}), born {{birth_date}}
Microchip number: {{microchip}}

Previous keeper: {{kennel_name}}
New keeper: {{buyer_name}}

The previous keeper confirms the transfer of registered keepership of the above
microchip to the new keeper on the date shown. The new keeper is responsible for
updating their contact details with the microchip database.

Previous keeper signature: .............................  Date: ..............

New keeper signature: ..................................  Date: ..............
`;

export const DEFAULT_TEMPLATES: DocTemplate[] = [
  { slug: 'contract', title: 'Puppy sale agreement', kind: 'contract', body: CONTRACT },
  { slug: 'deposit-receipt', title: 'Deposit receipt', kind: 'receipt', body: DEPOSIT_RECEIPT },
  { slug: 'health-guarantee', title: 'Health guarantee', kind: 'guarantee', body: HEALTH_GUARANTEE },
  { slug: 'microchip-handoff', title: 'Microchip keeper transfer', kind: 'handoff', body: MICROCHIP_HANDOFF },
];

export const KNOWN_SLUGS = DEFAULT_TEMPLATES.map((t) => t.slug);

export function defaultTemplate(slug: string): DocTemplate | undefined {
  return DEFAULT_TEMPLATES.find((t) => t.slug === slug);
}

const RX = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Unique `{{token}}` names in a template body, in first-seen order. */
export function templateTokens(body: string): string[] {
  return [...new Set([...body.matchAll(RX)].map((m) => m[1].toLowerCase()))];
}

/**
 * Fill `{{token}}` placeholders. Throws listing every token with no value: a
 * blank where the price or microchip should be is a data-loss hazard on a
 * document a buyer signs, so this fails loud rather than shipping a gap.
 */
export function renderTemplate(
  body: string,
  tokens: Record<string, string | number | null | undefined>,
): string {
  const missing: string[] = [];
  const out = body.replace(RX, (_m, raw: string) => {
    const k = raw.toLowerCase();
    const v = tokens[k];
    if (v === undefined || v === null || v === '') {
      missing.push(k);
      return '';
    }
    return String(v);
  });
  if (missing.length) throw new Error(`missing token(s): ${[...new Set(missing)].join(', ')}`);
  return out;
}

/**
 * Resolve one generated document. `tpl` is the built-in default with any kennel
 * override applied; `auto` are tokens derived from the subject; `caller` are
 * tokens supplied on the request and win over `auto`.
 */
export function buildDoc(
  tpl: DocTemplate,
  auto: Record<string, string | number | null | undefined>,
  caller: Record<string, string | number | null | undefined> = {},
): { kind: string; title: string; body: string } {
  const merged = { ...auto, ...caller };
  return { kind: tpl.kind, title: tpl.title, body: renderTemplate(tpl.body, merged) };
}
