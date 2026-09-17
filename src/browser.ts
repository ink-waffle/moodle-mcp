import { StudyBrowser } from "@ink-waffle/study-browser";
import type { BrowserContext, Page } from "playwright-core";
import { getBrowserOptions } from "./config.js";

let studyBrowser: StudyBrowser | undefined;
const pages = new Set<Page>();

function managedBrowser(): StudyBrowser {
  if (!studyBrowser) studyBrowser = new StudyBrowser({ browser: getBrowserOptions() });
  return studyBrowser;
}

export async function getContext(): Promise<BrowserContext> {
  return (await managedBrowser().getConnection()).context;
}

export async function openPage(): Promise<Page> {
  const page = await (await getContext()).newPage();
  pages.add(page);
  return page;
}

export async function closePage(args: { page: Page }): Promise<void> {
  const { page } = args;
  pages.delete(page);
  if (!page.isClosed()) await page.close().catch(() => {});
}

export async function closeContext(): Promise<void> {
  await Promise.all([...pages].map((page) => closePage({ page })));
  const current = studyBrowser;
  studyBrowser = undefined;
  await current?.disconnect();
}
