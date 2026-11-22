import {
  type AwakeEvent,
  type AwakeState,
  awakeChange,
  awakeNext,
  NOT_HOLDING,
} from "../shared/local/keep-awake-model.ts";

export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export class KeepAwake {
  private state: AwakeState = NOT_HOLDING;
  private blocker: number | null = null;

  constructor(private readonly power: PowerBlocker) {}

  apply(event: AwakeEvent): void {
    const next = awakeNext(this.state, event);
    const change = awakeChange(this.state, next);
    this.state = next;
    if (change === "start" && this.blocker === null)
      this.blocker = this.power.start("prevent-app-suspension");
    if (change === "stop" && this.blocker !== null) {
      this.power.stop(this.blocker);
      this.blocker = null;
    }
  }

  holding(): boolean {
    return this.blocker !== null;
  }
}
