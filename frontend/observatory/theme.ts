import { createTheme } from '@corefoundry-labs/forge-tokens/theme-v2';

// Seeds taken from the Figma frame (accent #6ce0b9, card #142023, warning #f4c988). The engine derives
// the remaining roles, so rendered values are close to, not identical with, the Figma hex codes.
export const observatoryTheme = createTheme({
  name: 'formiai-observatory',
  mode: 'dark',
  colors: { primary: '#6ce0b9', secondary: '#6ce0b9', neutral: '#142023', warning: '#f4c988' },
});
