import {
  DEFAULT_MAX_ENUM,
  type HarValidationFilter,
  type Shape,
  type ValidationResult,
} from "@quipu/contracts/schema";
import { create } from "zustand";

import { useRightPanelStore } from "../rightPanelStore.ts";
import {
  codegen,
  inferSchema,
  type OpenDocument,
  useDocumentSession,
  validateSchema,
} from "./documentSession.ts";

interface SchemaState {
  readonly documentId: number | null;
  readonly shape: Shape | null;
  readonly inferredSchemaText: string | null;
  readonly inferring: boolean;
  readonly inferError: string | null;
  readonly validating: boolean;
  readonly validationResult: ValidationResult | null;
  readonly validationError: string | null;
  readonly codegenOpen: boolean;
  readonly infer: (
    document: OpenDocument,
    target?: { readonly tapeId: number; readonly token: number },
    showTab?: boolean,
  ) => Promise<Shape | null>;
  readonly validate: (
    document: OpenDocument,
    schemaText: string,
    filter?: HarValidationFilter,
  ) => Promise<void>;
  readonly prepareValidationFromShape: (document: OpenDocument) => Promise<void>;
  readonly openCodegen: (document: OpenDocument) => Promise<void>;
  readonly setCodegenOpen: (open: boolean) => void;
  readonly clearValidation: () => void;
}

const errorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === "string" && msg.length > 0) return msg;
  }
  return error instanceof Error ? error.message : fallback;
};

let inferGeneration = 0;
let validateGeneration = 0;

export const useSchemaStore = create<SchemaState>((set, get) => ({
  documentId: null,
  shape: null,
  inferredSchemaText: null,
  inferring: false,
  inferError: null,
  validating: false,
  validationResult: null,
  validationError: null,
  codegenOpen: false,

  infer: async (document, target, showTab = true) => {
    const mine = ++inferGeneration;
    const ref = {
      documentId: document.documentId,
      tapeId: target?.tapeId ?? 0,
      token: target?.token ?? 0,
    };
    set({
      documentId: document.documentId,
      inferring: true,
      inferError: null,
    });
    if (showTab) useRightPanelStore.getState().showTab("schema");
    try {
      const shape = await inferSchema(ref);
      if (mine !== inferGeneration) return null;
      const schemaCode = await codegen(
        ref,
        { language: "json-schema", rootName: "Root", maxEnum: DEFAULT_MAX_ENUM },
        shape,
      )
        .then((res) => res.code)
        .catch(() => null);
      if (mine !== inferGeneration) return null;
      set({
        documentId: document.documentId,
        shape,
        inferredSchemaText: schemaCode,
        inferring: false,
        inferError: null,
      });
      return shape;
    } catch (error) {
      if (mine !== inferGeneration) return null;
      set({
        documentId: document.documentId,
        inferring: false,
        inferError: errorMessage(error, "Schema inference failed."),
      });
      return null;
    }
  },

  validate: async (document, schemaText, filter) => {
    const mine = ++validateGeneration;
    set({
      documentId: document.documentId,
      validating: true,
      validationError: null,
    });
    try {
      const result = await validateSchema(document.documentId, schemaText, filter ?? null);
      if (mine !== validateGeneration) return;
      set({
        documentId: document.documentId,
        validating: false,
        validationResult: result,
        validationError: null,
      });
    } catch (error) {
      if (mine !== validateGeneration) return;
      set({
        documentId: document.documentId,
        validating: false,
        validationResult: null,
        validationError: errorMessage(error, "Schema validation failed."),
      });
    }
  },

  prepareValidationFromShape: async (document) => {
    const { shape, inferredSchemaText } = get();
    if (shape !== null && inferredSchemaText === null) {
      const ref = { documentId: document.documentId, tapeId: 0, token: 0 };
      const code = await codegen(
        ref,
        { language: "json-schema", rootName: "Root", maxEnum: DEFAULT_MAX_ENUM },
        shape,
      )
        .then((res) => res.code)
        .catch(() => null);
      if (code !== null && get().documentId === document.documentId) {
        set({ inferredSchemaText: code });
      }
    }
    useRightPanelStore.getState().showTab("problems");
  },

  openCodegen: async (document) => {
    const state = get();
    if (state.shape === null && state.documentId !== document.documentId) {
      set({ documentId: document.documentId, shape: null, inferredSchemaText: null });
    }
    set({ codegenOpen: true });
    if (get().shape === null && !get().inferring) {
      await get().infer(document, undefined, false);
    }
  },

  setCodegenOpen: (codegenOpen) => set({ codegenOpen }),

  clearValidation: () => {
    validateGeneration++;
    set({ validating: false, validationResult: null, validationError: null });
  },
}));

let lastDocId: number | null = null;
useDocumentSession.subscribe((state) => {
  const docId = state.session.phase === "open" ? state.session.document.documentId : null;
  if (docId === lastDocId) return;
  lastDocId = docId;
  inferGeneration++;
  validateGeneration++;
  useSchemaStore.setState({
    documentId: docId,
    shape: null,
    inferredSchemaText: null,
    inferring: false,
    inferError: null,
    validating: false,
    validationResult: null,
    validationError: null,
    codegenOpen: false,
  });
});
