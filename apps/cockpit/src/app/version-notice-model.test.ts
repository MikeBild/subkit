import { describe, expect, mock, test } from "bun:test";
import { handleReloadAction } from "./version-notice-model";

const setup = (dirty: boolean) => {
  const preventDefault = mock(() => {});
  const warn = mock(() => {});
  const reload = mock(() => {});
  handleReloadAction({ dirty, preventDefault, warn, reload });
  return { preventDefault, warn, reload };
};

describe("handleReloadAction", () => {
  test("keeps the notice open and warns when forms are dirty", () => {
    const { preventDefault, warn, reload } = setup(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads into the update when no form is dirty", () => {
    const { preventDefault, warn, reload } = setup(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
