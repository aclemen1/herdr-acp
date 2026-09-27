import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export function selectValues(options: SessionConfigOption[], configId: string): string[] {
  const option = options.find((item) => item.id === configId);
  if (option?.type !== "select") return [];
  return (option.options as Array<{ value?: string; options?: { value: string }[] }>).flatMap((item) =>
    item.options ? item.options.map((child) => child.value) : item.value ? [item.value] : [],
  );
}
