/**
 * The music cue list, written by the audio pipeline. `import.meta.glob` resolves to nothing when
 * the file does not exist yet, so the build passes either way.
 */
const found = import.meta.glob('../../assets-source/audio/music/cues.json', {
  eager: true,
  import: 'default',
});

export const cuesDocument: unknown = Object.values(found)[0] ?? null;

declare const __AUDITION_SFX_FILES__: string[] | undefined;

/** Every file in `public/assets/audio/sfx/` at build time (empty under vitest, which skips the define). */
export const sfxFiles: string[] =
  typeof __AUDITION_SFX_FILES__ === 'undefined' ? [] : __AUDITION_SFX_FILES__;
