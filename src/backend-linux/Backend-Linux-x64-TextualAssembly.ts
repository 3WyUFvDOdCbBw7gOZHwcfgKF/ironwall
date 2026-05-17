export const GNU_STACK_SECTION_DIRECTIVE = ".section .note.GNU-stack,\"\",@progbits";

export function buildX64TextualAssembly(entryText: string, functionTexts: readonly string[]): string {
    const sections = [entryText, ...functionTexts, GNU_STACK_SECTION_DIRECTIVE].filter((section) => section.length > 0);
    return `${sections.join("\n\n")}\n`;
}