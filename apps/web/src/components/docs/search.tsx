"use client";

import DefaultSearchDialog, { type DefaultSearchDialogProps } from "fumadocs-ui/components/dialog/search-default";

/** Search over the index exported at build time (the site is static; there is no search server). */
export default function StaticSearch(props: DefaultSearchDialogProps) {
  return <DefaultSearchDialog {...props} type="static" api={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/search`} />;
}
