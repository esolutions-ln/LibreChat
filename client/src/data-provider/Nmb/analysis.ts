import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type {
  TNmbRun,
  TNmbDataset,
  TNmbExecuteBody,
  TNmbSynthesizeBody,
  TNmbSyntheticData,
  TNmbAnalysisLimits,
} from 'librechat-data-provider';
import type {
  UseQueryOptions,
  UseMutationResult,
  UseMutationOptions,
  QueryObserverResult,
} from '@tanstack/react-query';

type DatasetList = { items: TNmbDataset[] };

export const useNmbDatasetsQuery = (
  config?: UseQueryOptions<DatasetList>,
): QueryObserverResult<DatasetList> =>
  useQuery<DatasetList>([QueryKeys.nmbDatasets], () => dataService.getNmbDatasets(), {
    refetchOnWindowFocus: false,
    ...config,
  });

export const useNmbAnalysisLimitsQuery = (
  config?: UseQueryOptions<TNmbAnalysisLimits>,
): QueryObserverResult<TNmbAnalysisLimits> =>
  useQuery<TNmbAnalysisLimits>(
    [QueryKeys.nmbAnalysisLimits],
    () => dataService.getNmbAnalysisLimits(),
    { staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false, ...config },
  );

/** The synthetic twin is safe to show and to paste into chat. Fetched only once one exists. */
export const useNmbSyntheticQuery = (
  id: string | undefined,
  config?: UseQueryOptions<TNmbSyntheticData>,
): QueryObserverResult<TNmbSyntheticData> =>
  useQuery<TNmbSyntheticData>(
    [QueryKeys.nmbSynthetic, id],
    () => dataService.getNmbSynthetic(id as string),
    { enabled: id != null, refetchOnWindowFocus: false, retry: false, ...config },
  );

export const useUploadNmbDatasetMutation = (
  options?: UseMutationOptions<TNmbDataset, unknown, FormData>,
): UseMutationResult<TNmbDataset, unknown, FormData> => {
  const queryClient = useQueryClient();
  return useMutation((formData) => dataService.uploadNmbDataset(formData), {
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries([QueryKeys.nmbDatasets]);
      options?.onSuccess?.(data, variables, context);
    },
  });
};

export const useSynthesizeNmbDatasetMutation = (
  options?: UseMutationOptions<TNmbDataset, unknown, { id: string; body: TNmbSynthesizeBody }>,
): UseMutationResult<TNmbDataset, unknown, { id: string; body: TNmbSynthesizeBody }> => {
  const queryClient = useQueryClient();
  return useMutation(({ id, body }) => dataService.synthesizeNmbDataset(id, body), {
    ...options,
    onSuccess: (data, variables, context) => {
      queryClient.invalidateQueries([QueryKeys.nmbDatasets]);
      queryClient.invalidateQueries([QueryKeys.nmbSynthetic, variables.id]);
      options?.onSuccess?.(data, variables, context);
    },
  });
};

export const useExecuteNmbDatasetMutation = (
  options?: UseMutationOptions<TNmbRun, unknown, { id: string; body: TNmbExecuteBody }>,
): UseMutationResult<TNmbRun, unknown, { id: string; body: TNmbExecuteBody }> =>
  useMutation(({ id, body }) => dataService.executeNmbDataset(id, body), options);

export const useDeleteNmbDatasetMutation = (
  options?: UseMutationOptions<{ deleted: boolean }, unknown, string>,
): UseMutationResult<{ deleted: boolean }, unknown, string> => {
  const queryClient = useQueryClient();
  return useMutation((id) => dataService.deleteNmbDataset(id), {
    ...options,
    onSuccess: (data, id, context) => {
      queryClient.removeQueries([QueryKeys.nmbSynthetic, id]);
      queryClient.invalidateQueries([QueryKeys.nmbDatasets]);
      options?.onSuccess?.(data, id, context);
    },
  });
};
