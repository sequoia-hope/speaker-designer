<script lang="ts">
  let { onOpenLab }: { onOpenLab: () => void } = $props();
</script>

<section class="card">
  <h2>The plan, in four steps</h2>
  <ol class="plan">
    <li><b>Room</b> — your room's shape, a sound-system layout (stereo → surround → party), and where every speaker and the sofa go.</li>
    <li><b>Speakers</b> — a gallery of designs (monitors, towers, centre, small surrounds, ceiling speakers, subs) in 3D, sized from real driver datasheets.</li>
    <li><b>Build</b> — drawings, cut list, jig settings, sheet layout and a checklist of shop steps for each design.</li>
    <li><b>Parts</b> — the bill of materials for the whole system, with Parts Express part numbers — or the kit path.</li>
    <li><b>Tune</b> — once built: a $100 measurement mic + free REW software, then EQ the room peaks.</li>
  </ol>
</section>

<details class="acc" open>
  <summary>What makes a "sweet spot"</summary>
  <div class="acc-body">
    <p>Three separate things, and the app helps with each:</p>
    <ul>
      <li><b>Imaging</b> (where instruments seem to be): sit at the tip of a roughly equilateral triangle, toe the speakers in, keep the room symmetrical left/right, and tame the first side-wall reflections with panels.</li>
      <li><b>Tonal balance</b>: speakers whose off-axis sound is as smooth as their on-axis sound — that is why the crossover frequency and tweeter choice matter, not only the woofer.</li>
      <li><b>Even bass</b>: below ~150–200 Hz the room itself takes over. Where you sit decides which notes boom and which vanish. Moving the seat, the speakers, and adding two subwoofers are the strongest tools; EQ helps with peaks but cannot fill deep dips.</li>
    </ul>
    <p>A small, sharply-focused sweet spot (one chair, near-field) is easy. A sweet spot that covers a whole sofa needs the subwoofer trick and wider toe-in.</p>
  </div>
</details>

<details class="acc">
  <summary>Sound design for a room with guests</summary>
  <div class="acc-body">
    <p>Designing for hosting is different from designing for one perfect chair. The questions shift from "how sharp is the image?" to:</p>
    <ul>
      <li><b>Is it equally loud everywhere?</b> (the <i>Loudness coverage</i> map). Close to a speaker, level rises fast — 6 dB louder for every halving of distance. Spread the sound with several smaller speakers and less toe-in, rather than two loud ones aimed at one seat.</li>
      <li><b>Is the bass even?</b> (<i>Bass evenness</i>). Room resonances make bass boom in one spot and vanish a step away. Two subwoofers on opposite walls are the classic cure.</li>
      <li><b>Does the sound still come from the front?</b> Extra "fill" speakers at the back play a little quieter and <i>delayed</i> ~10–20 ms. Our hearing locks onto the first arrival (the precedence or Haas effect), so the music still seems to come from the mains while the back of the room gets filled in.</li>
      <li><b>Can people talk?</b> A room that is too live makes everyone raise their voice. Absorption at the reflection points (and soft furnishings) keeps conversation easy at party levels.</li>
    </ul>
    <p>The Room tab's layouts let you compare these trade-offs: switch between <i>Stereo</i> and <i>Guests / party</i> and watch the coverage and stereo-image maps change.</p>
  </div>
</details>

<details class="acc">
  <summary>Stereo vs surround vs Atmos — which for this room?</summary>
  <div class="acc-body">
    <ul>
      <li><b>2.1 / 2.2</b> — best value for music. Two great speakers and one or two subs.</li>
      <li><b>3.1 (LCR)</b> — add a centre when you watch TV with guests: dialogue stays on the screen for every seat.</li>
      <li><b>5.1</b> — surrounds add envelopment for films and games. Small speakers are fine; they're bass-managed to the sub.</li>
      <li><b>5.1.2</b> — two ceiling speakers add height. In a 12′ room with a 9′ ceiling this usually beats 7.1, which needs room behind the sofa.</li>
    </ul>
    <p>You can grow into it: build the mains and a sub first (2.1), add a centre later, then small surrounds and ceiling speakers — every design in the Speakers tab is sized to fit this room.</p>
  </div>
</details>

<details class="acc">
  <summary>Anatomy of a 2-way speaker</summary>
  <div class="acc-body">
    <ul>
      <li><b>Woofer</b> (6–8″): bass and midrange. Its Thiele-Small numbers (Fs, Qts, Vas) decide how big the box must be.</li>
      <li><b>Tweeter</b> (1″): treble, above ~2–3 kHz.</li>
      <li><b>Crossover</b>: splits the signal between them. Passive (coils & capacitors inside the box) or active (a DSP amplifier with separate channels per driver).</li>
      <li><b>Cabinet</b>: an airtight, stiff, braced wooden box. Sealed, or with a tuned port.</li>
      <li><b>Baffle</b>: the front panel. Its width sets the "baffle step" — the frequency below which sound wraps around the box and the speaker loses ~6 dB in free space (half of it comes back near a wall).</li>
    </ul>
  </div>
</details>

<details class="acc">
  <summary>Passive crossover or active DSP?</summary>
  <div class="acc-body">
    <p>
      The box is woodworking; the crossover is the electronics design, and it is what makes a speaker sound good or bad.
      Designing a passive crossover properly requires measuring the finished drivers in the finished box. Three sane routes
      for a first build:
    </p>
    <ul>
      <li><b>Build a published design</b> that uses the same drivers and box size (the crossover is already worked out).</li>
      <li><b>Buy a kit</b> with the crossover included.</li>
      <li><b>Go active</b>: a 4-channel DSP amplifier (or a miniDSP + amps). Crossover, delay, baffle-step and room EQ all become software settings you can change with a measurement mic. More flexible, more electronics, very forgiving.</li>
    </ul>
  </div>
</details>

<details class="acc">
  <summary>Sealed vs. vented, in one minute</summary>
  <div class="acc-body">
    <p>
      <b>Sealed</b>: the trapped air acts as a spring. Smaller box, gentle 12 dB/octave roll-off that the room partly
      fills in, great transient behaviour, very tolerant of building errors.
    </p>
    <p>
      <b>Vented</b>: a port resonates at a chosen frequency and adds output there. Deeper bass from the same woofer, but a
      bigger box, a steeper 24 dB/octave roll-off, and the woofer is unprotected below tuning.
    </p>
    <p>With subwoofers planned, sealed mains are the natural choice.</p>
  </div>
</details>

<details class="acc">
  <summary>About the "Acoustics Lab" (the original app) — what to trust</summary>
  <div class="acc-body">
    <p>
      The Lab is a large set of demos generated earlier. An independent check of its code found that the core bass-box
      physics (Thiele-Small, sealed/vented circuit models, port tuning, crossover filters) is correct and comparable to
      tools like WinISD. Much of the rest is not reliable for building:
    </p>
    <ul>
      <li>Its cabinet drawings do not match the volume and port length it simulates; driver holes are shrunk to whatever fits (an 8.5″ woofer gets a 124 mm hole) and one baffle layout physically overlaps.</li>
      <li>Its cut list labels joints "45° lock-miter" but gives butt-joint dimensions.</li>
      <li>Drivers in the Lab are invented — you can't buy them.</li>
      <li>Directivity/waveguide curves come from shaping formulas, "3D BEM" barely affects results, and the "Bayesian calibration" demo fits data generated by its own model.</li>
      <li>Several design notes quote numbers the simulation itself contradicts.</li>
      <li>It is aimed at CNC shops (aluminium billet baffles, NL4 connectors) and outdoor PA, not a home shop.</li>
    </ul>
    <p>
      This Home Hi-Fi section replaces those parts with real drivers, consistent cut lists, and a room model built for a
      living room. The Lab is still fun for exploring big outdoor systems and horn-loaded subwoofers.
    </p>
    <button class="btn ghost" onclick={onOpenLab}>Open the Acoustics Lab</button>
  </div>
</details>

<details class="acc">
  <summary>Glossary</summary>
  <div class="acc-body">
    <dl>
      <dt>Fs, Qts, Vas</dt><dd>Woofer's resonance, damping and "air-spring equivalent" volume — together they set box size and bass extension.</dd>
      <dt>Qtc</dt><dd>Damping of the woofer once in a sealed box. 0.71 = flattest response.</dd>
      <dt>f3 / −3 dB</dt><dd>Frequency where bass output has fallen to half power.</dd>
      <dt>Room mode</dt><dd>A frequency whose wavelength "fits" between two walls; it booms at some spots and vanishes at others.</dd>
      <dt>SBIR</dt><dd>Speaker-boundary interference: the bounce off the wall behind a speaker cancels one frequency band.</dd>
      <dt>Schroeder frequency</dt><dd>Above it, room resonances blur together and seat position matters much less.</dd>
      <dt>Baffle step</dt><dd>Loss of bass-midrange level when wavelengths get bigger than the front panel.</dd>
      <dt>Toe-in</dt><dd>Angling the speakers towards the listener.</dd>
    </dl>
  </div>
</details>

<style>
  .plan {
    padding-left: 20px;
    margin: 6px 0 0;
  }
  .plan li {
    margin: 6px 0;
    color: var(--text-1);
  }
  ul {
    padding-left: 18px;
  }
  li {
    margin: 5px 0;
  }
  dt {
    font-weight: 700;
    color: var(--text-0);
    margin-top: 8px;
  }
  dd {
    margin: 2px 0 0 0;
    color: var(--text-1);
  }
</style>
