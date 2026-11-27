
export interface NotifyToolInput {
  title: string;
  body: string;
  sessionId?: string;
  inbox?: boolean;
}

export type NotifyToolPort = (input: NotifyToolInput) => void;
