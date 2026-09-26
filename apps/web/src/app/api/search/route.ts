import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Static export: the search index is written at build time and searched in the browser.
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source, { language: "english" });
