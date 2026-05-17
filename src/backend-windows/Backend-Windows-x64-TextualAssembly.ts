export function buildX64TextualAssembly(entryText: string, functionTexts: readonly string[]): string {
    const sections = [entryText, ...functionTexts].filter((section) => section.length > 0);
    return `${sections.join("\n\n")}\n`;
}