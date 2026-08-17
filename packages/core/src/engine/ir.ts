import type {
  ActionRequest,
  ChangeOperation,
  ChangeOperationKind,
  CompositeResult,
  ChangeSet,
  DecisionStatus,
  DeferredSuggestion,
  UnifyDiffOperation as SharedUnifyDiffOperation,
} from '@delightify/shared';
import type { UnifyDiffOperation as DryRunUnifyDiffOperation } from '../unify/dry-run-service';

export type {
  ActionRequest,
  ChangeOperation,
  ChangeOperationKind,
  CompositeResult,
  ChangeSet,
  DecisionStatus,
  DeferredSuggestion,
};

type AssertAssignable<T extends U, U> = true;
export type DryRunUnifyDiffOperationAssignableToChangeOperation = AssertAssignable<
  DryRunUnifyDiffOperation,
  ChangeOperation
>;
export type SharedUnifyDiffOperationAssignableToChangeOperation = AssertAssignable<
  SharedUnifyDiffOperation,
  ChangeOperation
>;

export type MakeOperationParams = ChangeOperation;

export function makeOperation(params: MakeOperationParams): ChangeOperation {
  return { ...params };
}

export function makeChangeSet(operations: ChangeOperation[]): ChangeSet {
  return operations.filter(operation => operation.includedInChangeSet);
}
