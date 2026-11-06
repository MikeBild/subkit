import {
  getConnectorOperation,
  listConnectorsOperation,
} from "../../../api/operations/connectors.ts";
import { toConversationTool } from "../../../api/operations/tool.ts";
import type { ConversationTool } from "../index.ts";

export const listConnectorsTool: ConversationTool = toConversationTool(listConnectorsOperation);

export const getConnectorTool: ConversationTool = toConversationTool(getConnectorOperation);

export const connectorReadTools: ConversationTool[] = [listConnectorsTool, getConnectorTool];
