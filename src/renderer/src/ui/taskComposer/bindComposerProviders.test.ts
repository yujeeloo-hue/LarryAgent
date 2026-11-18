import assert from "node:assert/strict";
import test from "node:test";
import { setProvidersState } from "../../state/activeProviderState.js";
import {
  bindComposerProviders,
  type ComposerProvidersBinding,
} from "./bindComposerProviders.js";
import type { TaskComposerView } from "./TaskComposerView.js";

function stubComposer(shown: Array<{ ids: string[]; selected: string }>) {
  return {
    setProviders: (
      providers: Array<{ id: string }>,
      selectedId: string,
    ) => {
      shown.push({
        ids: providers.map((provider) => provider.id),
        selected: selectedId,
      });
    },
    setHealthOk: () => {},
    setOnProviderSelect: () => {},
  } as unknown as TaskComposerView;
}

test("composer drops a provider removed from the list and adopts the fallback", () => {
  setProvidersState({
    providers: [
      { id: "keep", name: "Keep", baseUrl: "https://keep.example/v1", modelId: "k" },
      { id: "gone", name: "Gone", baseUrl: "https://gone.example/v1", modelId: "g" },
    ],
    activeProviderId: "keep",
  });
  const shown: Array<{ ids: string[]; selected: string }> = [];
  const adopted: string[] = [];
  let selected = "gone";
  let binding: ComposerProvidersBinding | undefined;
  try {
    binding = bindComposerProviders(stubComposer(shown), {
      getProviderId: () => selected,
      onProviderSelect: () => {},
      onSelectionMissing: (providerId) => {
        selected = providerId;
        adopted.push(providerId);
      },
    });
    assert.deepEqual(shown[0], { ids: ["keep", "gone"], selected: "gone" });
    assert.deepEqual(adopted, []);

    setProvidersState({
      providers: [
        { id: "keep", name: "Keep", baseUrl: "https://keep.example/v1", modelId: "k" },
      ],
      activeProviderId: "keep",
    });
    assert.deepEqual(adopted, ["keep"]);
    assert.equal(selected, "keep");
    assert.deepEqual(shown.at(-1), { ids: ["keep"], selected: "keep" });

    setProvidersState({
      providers: [
        { id: "keep", name: "Keep", baseUrl: "https://keep.example/v1", modelId: "k" },
        { id: "extra", name: "Extra", baseUrl: "https://extra.example/v1", modelId: "e" },
      ],
      activeProviderId: "keep",
    });
    assert.deepEqual(adopted, ["keep"]);
    assert.deepEqual(shown.at(-1)?.ids, ["keep", "extra"]);
  } finally {
    binding?.dispose();
  }
});
