export interface RenderedSecurityHeaders {
  cspSource: string
  output: string
}

export function renderSecurityHeaders(indexHtml: string, headerTemplate: string): RenderedSecurityHeaders
export function generateSecurityHeaders(
  indexPath: string,
  templatePath: string,
  outputPath: string,
): Promise<string>
