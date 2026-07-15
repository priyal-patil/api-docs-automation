import { Page } from '@playwright/test';
import { DocRequest, DocParam, DocHeader, TryOutField, TryOutData } from '../../config/types';

/**
 * Scrapes a single request section from the doc page.
 * Extracts params + headers from the description section AND the Try Out panel.
 */
export async function scrapeRequestSection(
  page: Page,
  sectionLocator: string,
  module: string,
  docUrl: string
): Promise<{ doc: DocRequest; tryOut: TryOutData }> {
  const section = page.locator(sectionLocator);

  // ── Extract from description ─────────────────────────────────────────────
  const name = await section.locator('h2, h3').first().innerText();
  const description = await section.locator('p').first().innerText().catch(() => '');

  // HTTP method + endpoint from the code block / badge
  const methodBadge = await section.locator('[class*="method"], [class*="badge"]').first().innerText().catch(() => 'GET');
  const endpointText = await section.locator('code[class*="endpoint"], [class*="url"]').first().innerText().catch(() => '');
  const method = methodBadge.trim().toUpperCase() as DocRequest['method'];

  // Parameters table
  const params: DocParam[] = await section.locator('table').evaluateAll((tables) => {
    const result: DocParam[] = [];
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.toLowerCase().trim());
      if (!headers.some(h => h.includes('param') || h.includes('name') || h.includes('key'))) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length < 2) continue;
        result.push({
          name: cells[0] || '',
          type: cells[1] || 'string',
          required: cells.some(c => c.toLowerCase().includes('required')),
          description: cells[cells.length - 1] || '',
        });
      }
    }
    return result;
  });

  // Headers table
  const headers: DocHeader[] = await section.locator('table').evaluateAll((tables) => {
    const result: DocHeader[] = [];
    for (const table of tables) {
      const headerCells = Array.from(table.querySelectorAll('th')).map(th => th.innerText.toLowerCase().trim());
      if (!headerCells.some(h => h.includes('header'))) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
        if (cells.length < 2) continue;
        result.push({
          name: cells[0] || '',
          required: cells.some(c => c.toLowerCase().includes('required')),
          description: cells[cells.length - 1] || '',
        });
      }
    }
    return result;
  });

  // Expected status codes mentioned in description
  const bodyText = await section.innerText();
  const statusMatches = bodyText.match(/\b(200|201|204|400|401|403|404|422|429|500)\b/g) ?? [];
  const expectedStatusCodes = [...new Set(statusMatches.map(Number))].filter(c => c < 300);

  const docRequest: DocRequest = {
    module,
    name: name.trim(),
    method,
    endpoint: endpointText.trim(),
    description,
    params,
    headers,
    expectedStatusCodes: expectedStatusCodes.length > 0 ? expectedStatusCodes : [200],
    docUrl,
  };

  // ── Extract from Try Out panel ────────────────────────────────────────────
  const tryOutData = await scrapeTryOutPanel(page, section.locator('[data-testid="open-builder"], button:has-text("Open Builder"), [class*="try-out"]'));

  return { doc: docRequest, tryOut: tryOutData };
}

export async function scrapeTryOutPanel(page: Page, openButtonLocator: ReturnType<Page['locator']>): Promise<TryOutData> {
  const tryOutFields: TryOutField[] = [];
  const headerFields: TryOutField[] = [];
  let bodyContent: string | undefined;
  let defaultResponseCode: number | undefined;

  try {
    // Click Open Builder
    await openButtonLocator.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    // Check if a response code is already visible BEFORE sending (default state)
    const defaultCodeText = await page
      .locator('[class*="response-code"], [class*="status-code"]')
      .first()
      .innerText()
      .catch(() => '');

    if (defaultCodeText) {
      const code = parseInt(defaultCodeText.match(/\d{3}/)?.[0] ?? '0', 10);
      if (code >= 400) defaultResponseCode = code;
    }

    // Scrape param fields
    const paramRows = await page.locator('[class*="params"] [class*="row"], [class*="parameter-row"]').all();
    for (const row of paramRows) {
      const label = await row.locator('label, [class*="name"]').first().innerText().catch(() => '');
      const input = await row.locator('input, select').first().getAttribute('type').catch(() => 'text');
      if (label.trim()) {
        tryOutFields.push({ name: label.trim(), type: input ?? 'text' });
      }
    }

    // Scrape header fields
    const headerRows = await page.locator('[class*="headers"] [class*="row"], [class*="header-row"]').all();
    for (const row of headerRows) {
      const label = await row.locator('label, [class*="name"]').first().innerText().catch(() => '');
      if (label.trim()) {
        headerFields.push({ name: label.trim(), type: 'text' });
      }
    }

    // Scrape body editor
    bodyContent = await page
      .locator('[class*="body-editor"], [class*="request-body"] textarea, .CodeMirror')
      .first()
      .innerText()
      .catch(() => undefined);

  } catch {
    // Open Builder not found or panel did not open — recorded as empty
  }

  return {
    requestName: '',
    params: tryOutFields,
    headers: headerFields,
    bodyContent,
    defaultResponseCode,
  };
}
