# Cinematic clips

Optional footage for the three places where real light does something code can't: the sign-in
window, the band behind the public report page, and the 404 window. **Nothing here is required.**
With this folder empty, those places show the live, code-drawn mosaic and no video is ever
requested.

To add a clip, drop its files here with exactly these names and rebuild the client
(`npm run build`). The build finds them by name (`src/components/cinematic.jsx`), gives them
hashed URLs, and the page switches from the code mosaic to the footage on its own.

| Slot | Files | Size (pixels) | Shown at | Length |
|---|---|---|---|---|
| Sign-in window | `login-hero.webm`, `login-hero.mp4`, `login-hero.jpg` | 960 × 1152 (5:6, portrait) | the arched window on the sign-in and sign-up pages, wide screens | 6 s loop |
| Report page band | `portal-hero.webm`, `portal-hero.mp4`, `portal-hero.jpg` | 1920 × 640 (3:1) | the glass band behind the top of every public report page | 8 s loop |
| 404 window | `not-found.webm`, `not-found.mp4`, `not-found.jpg` | 720 × 864 (5:6, portrait) | the arched window on the "This page isn't here" page | 5 s loop |

Rules each clip must meet (the player already does the rest):

- **No audio track**, under **3 MB per file**, WebM (VP9) and MP4 (H.264) both present.
- **Seamless loop**: the last frame flows into the first.
- **Poster**: the `.jpg` is a still from the clip (the first frame is best). It is shown for
  reduced motion and data-saver users and before the clip is near the screen.
- Already handled by the player: muted, looped, inline on phones, loaded only when close to the
  screen, paused when off-screen or in a hidden tab, and a gradient overlay wherever text sits on
  top.

## Compressing (ffmpeg, free)

Run on the clip exported from the generator (`raw.mp4`), changing the size and name per slot:

```bash
ffmpeg -i raw.mp4 -an -vf "scale=960:1152:force_original_aspect_ratio=increase,crop=960:1152,fps=24" -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 38 -row-mt 1 -deadline good login-hero.webm
ffmpeg -i raw.mp4 -an -vf "scale=960:1152:force_original_aspect_ratio=increase,crop=960:1152,fps=24" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart login-hero.mp4
ffmpeg -i login-hero.mp4 -frames:v 1 -q:v 3 login-hero.jpg
```

If a file is over 3 MB, raise `-crf` by 2 and run it again.

## Prompts

Written for Higgsfield or Runway (image-to-video or text-to-video). Colours are the brand tokens:
amber `#F7B23B`, rose `#F2557D`, violet `#8B6CF6`, on near-black `#09090C`.

**1. `login-hero`: light through the window**

> Extreme close-up of a leaded stained-glass window made of rectangular panes of different sizes,
> no figures or symbols, just colour fields: warm amber #F7B23B at the top left, rose #F2557D
> across the middle, soft violet #8B6CF6 at the bottom right, with a few clear panes. Dark room
> behind the camera, near-black #09090C. Late-afternoon sunlight moves slowly across the glass
> from left to right, so each pane brightens and dims in turn; faint dust drifts in the beams.
> Camera: locked off, an imperceptibly slow push-in. Soft, calm, high dynamic range, shallow
> depth of field on the lead lines, film grain. Portrait 4:5, 6 seconds, seamless loop, no text,
> no people.

**2. `portal-hero`: coloured light on a wall**

> A wide, shallow-angle shot of a matte off-white plaster wall, onto which sunlight through an
> unseen stained-glass window casts soft rectangles of coloured light: amber #F7B23B, rose
> #F2557D and violet #8B6CF6, slightly blurred at the edges. Leaves outside sway gently, so the
> coloured patches shimmer and drift a few centimetres, never leaving the frame. Camera: static
> on a tripod. Quiet, warm, morning mood, very low contrast so text can sit on top. Ultra-wide
> 21:9, 8 seconds, seamless loop, no text, no objects, no people.

**3. `not-found`: the missing pane**

> Close-up of a small arched stained-glass window of rectangular panes in amber #F7B23B, rose
> #F2557D and violet #8B6CF6, set in dark lead against a near-black #09090C room. One pane near
> the centre is missing: the empty gap glows with a thin, slow-pulsing rose #F2557D rim of light,
> as if light is leaking around its edge. Dust floats through the gap in a slow beam. Camera:
> locked off, with a very gentle parallax drift of a few pixels. Moody, quiet, cinematic, film
> grain. Portrait 4:5, 5 seconds, seamless loop, no text, no people.

## Cost

Higgsfield and Runway both give free trial credits, but three clips with retries may need a
paid plan. Check the credit cost on their pricing page before generating; the code-drawn mosaic
is a complete result on its own.
