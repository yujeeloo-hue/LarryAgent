export const clipText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
