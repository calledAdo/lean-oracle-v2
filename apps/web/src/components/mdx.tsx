import defaultMdxComponents from "fumadocs-ui/mdx";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { MDXComponents } from "mdx/types";
import { FeedTable } from "@/components/docs/feed-table";
import { NetworkTable } from "@/components/docs/network-table";
import { PushPull } from "@/components/docs/push-pull";
import { Pipeline } from "@/components/docs/pipeline";
import { CellLifecycle } from "@/components/docs/cell-lifecycle";
import { MirrorTry } from "@/components/docs/mirror-try";
import { MerkleTree } from "@/components/docs/merkle-tree";
import { TxAnatomy } from "@/components/docs/tx-anatomy";
import { FeedDetail } from "@/components/docs/feed-detail";
import { CommitteeDetail } from "@/components/docs/committee-detail";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Callout,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    FeedTable,
    NetworkTable,
    PushPull,
    Pipeline,
    CellLifecycle,
    MirrorTry,
    MerkleTree,
    TxAnatomy,
    FeedDetail,
    CommitteeDetail,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
