import tokens from '../../packages/design-tokens/dist/tokens.native.json';

export type Theme = typeof tokens & {
  color: typeof tokens.color & { primary: string }
}

const theme: Theme = {
  ...tokens,
  color: { ...tokens.color, primary: tokens.color?.accent || '#22c55e' }
};

export function useTheme() { return theme; }

