// Catalogue of speaker designs you can build. Each is a starting point for the
// planner (drivers + box + shape); the Speakers tab lets you tweak a copy.

import type { Arrangement, BoxType, PortSide } from './speakerBuild';

export type Role = 'mains' | 'center' | 'surround' | 'height' | 'fill' | 'sub';

export interface DesignSettings {
  arrangement: Arrangement;
  wooferId: string;
  tweeterId: string;
  boxType: BoxType;
  targetQtc: number;
  tuningScale: number;
  volumeScale: number;
  portSide: PortSide;
  materialId: string;
  doubleBaffle: boolean;
  roundoverMm: number;
  quantity: number;
  stands: boolean;
  aspect: 'bookshelf' | 'tall' | 'cube';
}

export interface DesignPreset {
  id: string;
  name: string;
  short: string;
  roles: Role[];
  difficulty: 1 | 2 | 3;
  blurb: string;
  learn: string;
  settings: DesignSettings;
}

const base: Omit<DesignSettings, 'arrangement' | 'wooferId' | 'tweeterId'> = {
  boxType: 'sealed',
  targetQtc: 0.707,
  tuningScale: 1,
  volumeScale: 1,
  portSide: 'front',
  materialId: 'bb18',
  doubleBaffle: false,
  roundoverMm: 12.7,
  quantity: 2,
  stands: true,
  aspect: 'bookshelf',
};

export const DESIGNS: DesignPreset[] = [
  {
    id: 'monitor',
    name: 'Stand-mount monitor',
    short: '6.5″ 2-way, sealed',
    roles: ['mains', 'surround'],
    difficulty: 1,
    blurb: 'The classic: one woofer, one tweeter, a small sealed box on a stand. Sharp imaging, easy to place, easy to build.',
    learn: 'Small boxes "disappear" acoustically — less cabinet to reflect and diffract sound — so stereo imaging is usually best from compact monitors. Bass below ~60 Hz is left to the room and a sub.',
    settings: { ...base, arrangement: 'wt', wooferId: 'sb17nrx2c35-8', tweeterId: 'sb26stac-c000-4' },
  },
  {
    id: 'monitor-vented',
    name: 'Ported monitor',
    short: '7″ 2-way, vented',
    roles: ['mains'],
    difficulty: 2,
    blurb: 'Same idea, with a tuned port for about half an octave deeper bass — for a system without a subwoofer.',
    learn: 'A port is a tube of air that resonates with the air in the box (a Helmholtz resonator, like blowing over a bottle). Tuned below the woofer\'s own roll-off, it extends bass, but the box gets bigger and the roll-off steeper.',
    settings: { ...base, arrangement: 'wt', boxType: 'vented', wooferId: 'rs180-8', tweeterId: 'sb26stac-c000-4' },
  },
  {
    id: 'mtm',
    name: 'MTM monitor',
    short: '2 × 6.5″ + tweeter, sealed',
    roles: ['mains', 'center'],
    difficulty: 2,
    blurb: 'Woofer–tweeter–woofer (a "D\'Appolito" layout). More output and a vertically symmetric pattern that keeps floor and ceiling bounces down.',
    learn: 'With a woofer above and below the tweeter, the sound pattern narrows vertically around the crossover — so less sound hits the floor and ceiling, which matters in a 9′ room.',
    settings: { ...base, arrangement: 'mtm', wooferId: 'sb17nrx2c35-8', tweeterId: 'sb26stac-c000-4' },
  },
  {
    id: 'tower',
    name: 'Floor-standing tower',
    short: '2.5-way, 2 × 6.5″, vented',
    roles: ['mains'],
    difficulty: 3,
    blurb: 'A tall cabinet that needs no stand: two woofers share the bass for more output and depth; tweeter at seated ear height.',
    learn: '"2.5-way" means both woofers play bass, but only the upper one plays up to the tweeter — the lower one is rolled off earlier. That gives bass output without the vertical lobing of two drivers playing the same high notes.',
    settings: { ...base, arrangement: 'tower', boxType: 'vented', wooferId: 'sb17nrx2c35-8', tweeterId: 'sb26stac-c000-4', stands: false },
  },
  {
    id: 'center',
    name: 'Centre channel',
    short: 'Horizontal 2 × 6.5″ + tweeter',
    roles: ['center'],
    difficulty: 2,
    blurb: 'Lies on its side under or above a TV. Anchors dialogue to the screen for everyone on the sofa, not just the middle seat.',
    learn: 'A phantom centre (voice made by L+R together) only works in the middle seat. A real centre speaker makes voices come from the screen for every guest. Horizontal MTMs narrow sideways near the crossover, so keep it toed slightly up toward ear height.',
    settings: { ...base, arrangement: 'center', wooferId: 'sb17nrx2c35-8', tweeterId: 'sb26stac-c000-4', quantity: 1, stands: false, portSide: 'rear' },
  },
  {
    id: 'compact',
    name: 'Compact surround / height',
    short: '5″ + 1″, sealed, ~2 L',
    roles: ['surround', 'height', 'fill'],
    difficulty: 1,
    blurb: 'A small wall-hung 2-way (Parts Express drivers). Surrounds, ceiling speakers and party fills don\'t need deep bass — the subs handle that.',
    learn: 'Surround and height channels are crossed over to the subwoofer at ~80–120 Hz by the receiver ("bass management"), so these boxes can be tiny. What matters is a wide, smooth spread of sound, not depth.',
    settings: { ...base, arrangement: 'wt', wooferId: 'rs125-8', tweeterId: 'nd25fa-4', targetQtc: 0.65, stands: false, roundoverMm: 6 },
  },
  {
    id: 'fullrange',
    name: '4″ full-range ceiling speaker',
    short: 'One driver, no crossover, ~3 L',
    roles: ['height', 'fill'],
    difficulty: 1,
    blurb: 'The simplest speaker there is: one 4″ driver in a tiny sealed box, wired straight to the terminals. Great first build and good enough for height effects.',
    learn: 'A full-range driver avoids the crossover entirely — no phase problems between drivers — but beams treble above ~4 kHz and can\'t play loud bass. Perfect for overhead effects and background fill.',
    settings: { ...base, arrangement: 'fr', wooferId: 'rs100-8', tweeterId: '', stands: false, roundoverMm: 6 },
  },
  {
    id: 'budget',
    name: 'Budget monitor (Parts Express)',
    short: 'DC160 6.5″ + ND25FA, ~$95/pair drivers',
    roles: ['mains', 'surround'],
    difficulty: 1,
    blurb: 'An inexpensive first pair using only Parts Express drivers. Good practice build; pair with a sub.',
    learn: 'Cheaper drivers usually give up excursion (how loud the bass can go) and smoothness at the top of the woofer\'s range. With a sub doing the bass, a budget 2-way can sound surprisingly good.',
    settings: { ...base, arrangement: 'wt', wooferId: 'dc160-8', tweeterId: 'nd25fa-4' },
  },
  {
    id: 'sub12',
    name: '12″ sealed subwoofer',
    short: 'Dayton RSS315HFA, ~66 L',
    roles: ['sub'],
    difficulty: 1,
    blurb: 'A plain sealed cube with a plate amp. Deep, tight bass and very forgiving — the simplest big box to build.',
    learn: 'Sealed subs roll off gently, which in a small room partly cancels the room\'s own bass build-up ("room gain"). With a DSP plate amp you can EQ out the room peaks.',
    settings: { ...base, arrangement: 'sub', boxType: 'sealed', wooferId: 'rss315hfa-8', tweeterId: '', aspect: 'cube', quantity: 1, stands: false, roundoverMm: 6 },
  },
  {
    id: 'sub10',
    name: '10″ compact sub',
    short: 'Dayton RSS265HO, ~20 L',
    roles: ['sub'],
    difficulty: 1,
    blurb: 'A small sealed sub that hides beside a sofa or in a corner. Two of these beat one big sub in a small room.',
    learn: 'Several small subs spread around a room excite the room\'s resonances more evenly than one big sub — evenness across seats matters more than maximum depth in a 12′ room.',
    settings: { ...base, arrangement: 'sub', boxType: 'sealed', targetQtc: 0.6, wooferId: 'rss265ho-4', tweeterId: '', aspect: 'cube', quantity: 2, stands: false, roundoverMm: 6 },
  },
  {
    id: 'sub12-vented',
    name: '12″ ported subwoofer',
    short: 'SB Acoustics SB34SWNRX, ~94 L',
    roles: ['sub'],
    difficulty: 2,
    blurb: 'Bigger box, deeper and louder bass (−3 dB ≈ 25 Hz). Movie-night rumble.',
    learn: 'Vented subs trade size for efficiency near tuning. In a small room they can sound boomy unless placed and EQ\'d carefully.',
    settings: { ...base, arrangement: 'sub', boxType: 'vented', wooferId: 'sb34swnrx-s75-6', tweeterId: '', aspect: 'cube', quantity: 1, stands: false, roundoverMm: 6 },
  },
];

export function designById(id: string) {
  return DESIGNS.find((d) => d.id === id);
}
