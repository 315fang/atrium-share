// Modified for Atrium Share. See ATTRIBUTION.md for upstream provenance and changes.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  checkSession,
  createFolder,
  deleteObject,
  deletePrefix,
  getBuckets,
  getBucketSize,
  getDownloadUrl,
  getObjects,
  getRuntimeConfig,
  login,
  requestBucketSizeCalculation,
  logout,
  uploadFile,
  refreshObjectIndex,
} from "./lib/api";
import type {
  BucketSizeResponse,
  FileEntry,
  ListObjectsResponse,
  UploadSelection,
  UploadSourceFile,
  UploadTask,
} from "./lib/types";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CreateFolderDialog } from "../components/CreateFolderDialog";
import { FilePreview } from "../components/FilePreview";
import { LoginForm } from "../components/LoginForm";
import { ObjectTable } from "../components/ObjectTable";
import { Dialog } from "../components/Dialog";
import { useMediaQuery } from "./lib/use-media-query";
import { useDialog } from "./lib/use-dialog";
import {
  buildPdfPreviewTarget,
  shouldClosePdfPreview,
  type PdfPreviewTarget,
} from "../components/pdf-preview-target";
import { UploadDropzone } from "../components/UploadDropzone";
import { ShareDialog } from "../components/ShareDialog";
import { ShareManager } from "../components/ShareManager";
import type { ShareCollectionResult } from "./lib/api";
import { isSortMode, sortEntries, type SortMode } from "./lib/sort-files";

type DeleteTarget = { type: "file"; key: string } | { type: "folder"; key: string } | null;
type SelectedObject = FileEntry;
type ObjectsPageParam = { continuationToken?: string; maxKeys: number };
const UPLOAD_CONCURRENCY = 2;
const UPLOAD_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  uploading: "上传中",
  paused: "已暂停",
  skipped: "已跳过同名文件",
  success: "完成",
  error: "失败",
  canceled: "已取消",
};
const INITIAL_PAGE_SIZE = 100;
const PdfPreview = lazy(async () => {
  const module = await import("../components/PdfPreview");
  return { default: module.PdfPreview };
});

const calculateNextPageSize = (loadedItems: number): number => {
  if (loadedItems <= 100) {
    return 250;
  }

  if (loadedItems < 500) {
    return 500;
  }

  return 1000;
};

const normalizeRelativePath = (value: string): string => {
  return value
    .replace(/\\+/g, "/")
    .split("/")
    .filter((segment) => Boolean(segment) && segment !== ".")
    .join("/");
};

const splitPathSegments = (value: string): string[] => {
  return normalizeRelativePath(value)
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const buildPromptedFolderKey = (bucket: string, key: string): string => `${bucket}::${key}`;

export const App = () => {
  const queryClient = useQueryClient();
  const [authScope, setAuthScope] = useState(() => crypto.randomUUID());
  const sessionGenerationRef = useRef(0);
  const [shareManagerOpen, setShareManagerOpen] = useState(false);
  const [uploadConflict, setUploadConflict] = useState<"keep-both" | "skip" | "replace">(
    "keep-both",
  );
  const [showUploadHistory, setShowUploadHistory] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedBucket, setSelectedBucket] = useState("");
  const [currentPrefix, setCurrentPrefix] = useState("");
  const [selectedObject, setSelectedObject] = useState<SelectedObject | null>(null);
  const [filter, setFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [isSearchDebouncing, setIsSearchDebouncing] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      const saved = window.localStorage.getItem("atrium-sort-v1");
      return isSortMode(saved) ? saved : "modified-desc";
    } catch {
      return "modified-desc";
    }
  });
  const [isSorting, setIsSorting] = useState(false);
  const [folderLoadLimit, setFolderLoadLimit] = useState<number | null>(null);
  const [pendingLargeFolderKey, setPendingLargeFolderKey] = useState<string | null>(null);
  const [autoLoadOnScroll, setAutoLoadOnScroll] = useState(true);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [isUploadingBatch, setIsUploadingBatch] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [selectedFileKeys, setSelectedFileKeys] = useState<Set<string>>(new Set());
  const [shareRequest, setShareRequest] = useState<{
    bucket: string;
    files: FileEntry[];
    title: string;
    cacheKey: string;
  } | null>(null);
  const shareCacheRef = useRef(new Map<string, ShareCollectionResult>());
  const latestUploadBatchIdsRef = useRef<Set<string>>(new Set());
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [pdfPreviewTarget, setPdfPreviewTarget] = useState<PdfPreviewTarget | null>(null);
  const previewToggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const compactLayout = useMediaQuery("(max-width: 1100px)");
  const mobileLayout = useMediaQuery("(max-width: 768px)");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const shouldRestorePreviewToggleFocusRef = useRef(false);
  const prefetchInFlightRef = useRef(false);
  const promptedFolderKeysRef = useRef<Set<string>>(new Set());
  const promptedFolderLoadLimitsRef = useRef<Map<string, number | null>>(new Map());
  const requestedBucketSizeBucketsRef = useRef<Set<string>>(new Set());
  const tableScrollPositionsRef = useRef<Map<string, number>>(new Map());
  const scrollPersistTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastScrollKeyRef = useRef<string | null>(null);
  const uploadSourceMapRef = useRef<Map<string, UploadSourceFile>>(new Map());
  const uploadAbortMapRef = useRef<Map<string, () => void>>(new Map());
  const uploadPauseMapRef = useRef<Map<string, () => void>>(new Map());
  const pausedUploadTaskIdsRef = useRef<Set<string>>(new Set());
  const canceledUploadTaskIdsRef = useRef<Set<string>>(new Set());
  const uploadBatchInFlightRef = useRef(false);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        uploadTasks.some(
          (task) =>
            task.status === "uploading" || task.status === "queued" || task.status === "paused",
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadTasks]);

  useEffect(() => {
    let active = true;

    const init = async () => {
      try {
        const ok = await checkSession();
        if (active) {
          setIsAuthenticated(ok);
        }
      } finally {
        if (active) {
          setAuthLoading(false);
        }
      }
    };

    void init();

    return () => {
      active = false;
    };
  }, []);

  const bucketsQuery = useQuery({
    queryKey: ["buckets", authScope, isAuthenticated],
    queryFn: getBuckets,
    enabled: isAuthenticated,
  });

  const runtimeConfigQuery = useQuery({
    queryKey: ["runtime-config"],
    queryFn: getRuntimeConfig,
    enabled: isAuthenticated,
  });

  const shareFeatures = runtimeConfigQuery.data?.features;
  const shareBaseUrlForTable =
    shareFeatures?.shareBaseUrl &&
    (!shareFeatures.shareBucket || shareFeatures.shareBucket === selectedBucket)
      ? shareFeatures.shareBaseUrl
      : undefined;

  const uploadedShareFiles = useMemo<FileEntry[]>(() => {
    if (!shareBaseUrlForTable) return [];
    const filesByKey = new Map<string, FileEntry>();
    for (const task of uploadTasks) {
      if (
        task.status !== "success" ||
        !task.key ||
        task.bucket !== selectedBucket ||
        !latestUploadBatchIdsRef.current.has(task.id)
      )
        continue;
      filesByKey.set(task.key, {
        type: "file",
        key: task.key,
        name: task.filename,
        size: task.size,
        lastModified: task.lastModified,
        contentType: task.contentType,
      });
    }
    return Array.from(filesByKey.values());
  }, [selectedBucket, shareBaseUrlForTable, uploadTasks]);

  const openShare = useCallback(
    (files: FileEntry[], title?: string) => {
      if (!files.length || !selectedBucket) return;
      if (files.length > 1000) {
        setGlobalError("一次最多分享 1,000 个文件，请缩小选择范围。");
        return;
      }
      const cacheKey = JSON.stringify([
        selectedBucket,
        files
          .map((file) => [file.key, file.lastModified, file.size])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ]);
      setShareRequest({
        bucket: selectedBucket,
        files,
        title: (
          title ||
          (files.length === 1
            ? files[0].name
            : `${currentPrefix.split("/").filter(Boolean).at(-1) || "文件"}分享`)
        ).slice(0, 120),
        cacheKey,
      });
    },
    [selectedBucket, currentPrefix],
  );
  const cacheCreatedShare = useCallback(
    (result: ShareCollectionResult) => {
      if (shareRequest) shareCacheRef.current.set(shareRequest.cacheKey, result);
    },
    [shareRequest],
  );

  useEffect(() => {
    setSelectedFileKeys(new Set());
    setShareRequest(null);
  }, [selectedBucket, currentPrefix]);
  useEffect(() => {
    try {
      window.localStorage.setItem("atrium-sort-v1", sortMode);
    } catch {
      /* Sorting still works when storage is unavailable. */
    }
  }, [sortMode]);

  useEffect(() => {
    if (!selectedBucket && bucketsQuery.data?.length) {
      setSelectedBucket(bucketsQuery.data[0]);
    }
  }, [bucketsQuery.data, selectedBucket]);

  const bucketSizeQuery = useQuery({
    queryKey: ["bucket-size", authScope, selectedBucket],
    queryFn: async (): Promise<BucketSizeResponse | null> => {
      if (!selectedBucket) {
        return null;
      }

      const size = await getBucketSize(selectedBucket);

      if (size) {
        return size;
      }

      if (!requestedBucketSizeBucketsRef.current.has(selectedBucket)) {
        requestedBucketSizeBucketsRef.current.add(selectedBucket);
        await requestBucketSizeCalculation(selectedBucket).catch(() => undefined);
      }

      return null;
    },
    enabled: isAuthenticated && Boolean(selectedBucket),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 5 * 60 * 1000,
    refetchInterval: (query) => {
      const data = query.state.data as BucketSizeResponse | null | undefined;

      if (!selectedBucket || data) {
        return false;
      }

      return requestedBucketSizeBucketsRef.current.has(selectedBucket) ? 15_000 : false;
    },
  });

  const isBucketSizeKnown = bucketSizeQuery.data !== null;
  const isBucketSizeUnknown =
    !isBucketSizeKnown &&
    Boolean(selectedBucket) &&
    requestedBucketSizeBucketsRef.current.has(selectedBucket);
  const isLargeBucket = isBucketSizeKnown
    ? (bucketSizeQuery.data?.objectCount ?? 0) >= 10_000
    : false;
  const shouldShowLargeFolderPrompt = false;

  const objectsQuery = useInfiniteQuery<
    ListObjectsResponse,
    Error,
    InfiniteData<ListObjectsResponse>,
    [string, string, string, number, string, string, string],
    ObjectsPageParam
  >({
    queryKey: [
      "objects",
      selectedBucket,
      currentPrefix,
      folderLoadLimit ?? 0,
      sortMode,
      filter,
      authScope,
    ],
    queryFn: ({ pageParam }) =>
      getObjects(selectedBucket, currentPrefix, {
        continuationToken: pageParam.continuationToken,
        maxKeys: pageParam.maxKeys,
        sort: sortMode,
        search: filter,
      }),
    initialPageParam: {
      continuationToken: undefined,
      maxKeys:
        folderLoadLimit !== null
          ? Math.min(INITIAL_PAGE_SIZE, Math.max(1, folderLoadLimit))
          : INITIAL_PAGE_SIZE,
    },
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.nextContinuationToken) {
        return undefined;
      }

      const loadedItems = allPages.reduce(
        (sum, page) => sum + page.folders.length + page.files.length,
        0,
      );
      const remainingItems =
        folderLoadLimit !== null
          ? Math.max(0, folderLoadLimit - loadedItems)
          : Number.POSITIVE_INFINITY;

      if (remainingItems <= 0) {
        return undefined;
      }

      const nextMaxKeys = Math.min(calculateNextPageSize(loadedItems), remainingItems);

      return {
        continuationToken: lastPage.nextContinuationToken,
        maxKeys: Math.max(1, nextMaxKeys),
      };
    },
    enabled: isAuthenticated && Boolean(selectedBucket),
    refetchInterval: (query) => (query.state.data?.pages[0]?.indexing ? 1000 : false),
  });

  const objectsData = useMemo(() => {
    if (!objectsQuery.data?.pages.length) {
      return null;
    }

    const foldersByKey = new Map<
      string,
      (typeof objectsQuery.data.pages)[number]["folders"][number]
    >();
    const filesByKey = new Map<string, (typeof objectsQuery.data.pages)[number]["files"][number]>();

    for (const page of objectsQuery.data.pages) {
      for (const folder of page.folders) {
        foldersByKey.set(folder.key, folder);
      }

      for (const file of page.files) {
        filesByKey.set(file.key, file);
      }
    }

    const firstPage = objectsQuery.data.pages[0];
    const lastPage = objectsQuery.data.pages[objectsQuery.data.pages.length - 1];

    return {
      bucket: firstPage.bucket,
      prefix: firstPage.prefix,
      folders: Array.from(foldersByKey.values()),
      files: Array.from(filesByKey.values()),
      isTruncated: lastPage.isTruncated,
      nextContinuationToken: lastPage.nextContinuationToken,
    };
  }, [objectsQuery.data]);

  const canLoadMore = Boolean(objectsData?.isTruncated && objectsQuery.hasNextPage);
  const tableStateKey = `${selectedBucket}::${currentPrefix}`;
  const loadedObjectCount = (objectsData?.folders.length ?? 0) + (objectsData?.files.length ?? 0);
  const sortTier =
    loadedObjectCount < 1_000 ? "small" : loadedObjectCount < 10_000 ? "medium" : "large";
  const loadedObjectsLabel = objectsData
    ? objectsData.isTruncated
      ? `已加载 ${loadedObjectCount.toLocaleString()}+ 个对象`
      : `已加载 ${loadedObjectCount.toLocaleString()} 个对象`
    : null;
  const indexStatus = objectsQuery.data?.pages[0];
  const searchLimitWarning = indexStatus?.indexError
    ? `索引更新失败：${indexStatus.indexError}。请刷新重试。`
    : null;
  const sortWarning = indexStatus?.indexing
    ? "正在同步文件索引，完成后会自动更新。搜索和排序覆盖整个目录。"
    : null;

  const folderHealthLabel = isLargeBucket
    ? `大存储桶:约 ${(bucketSizeQuery.data?.objectCount ?? 0).toLocaleString()} 个对象`
    : isBucketSizeUnknown
      ? "正在统计存储桶大小,完成前大目录提醒将保持开启。"
      : null;

  useEffect(() => {
    if (searchInput === filter) {
      setIsSearchDebouncing(false);
      return;
    }

    setIsSearchDebouncing(true);
    const timeoutId = window.setTimeout(() => {
      setFilter(searchInput);
      setIsSearchDebouncing(false);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [filter, searchInput]);

  useEffect(() => {
    if (sortTier === "medium" && sortMode !== "name-asc") {
      setIsSorting(true);
      const timeoutId = window.setTimeout(() => {
        setIsSorting(false);
      }, 220);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    setIsSorting(false);
  }, [sortMode, sortTier]);

  const clearSearch = useCallback(() => {
    setSearchInput("");
    setFilter("");
    setIsSearchDebouncing(false);
  }, []);

  const sortedObjects = useMemo(
    () => (objectsData ? sortEntries(objectsData.folders, objectsData.files, sortMode) : null),
    [objectsData, sortMode],
  );
  const visibleFiles = useMemo(
    () =>
      (sortedObjects?.files ?? []).filter((file) =>
        file.name.toLowerCase().includes(filter.toLowerCase()),
      ),
    [filter, sortedObjects],
  );
  const selectedFiles = useMemo(
    () => (sortedObjects?.files ?? []).filter((file) => selectedFileKeys.has(file.key)),
    [selectedFileKeys, sortedObjects],
  );
  const allVisibleSelected =
    visibleFiles.length > 0 && visibleFiles.every((file) => selectedFileKeys.has(file.key));
  const toggleFileSelection = useCallback((key: string) => {
    setSelectedFileKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleVisibleSelection = () => {
    setSelectedFileKeys((previous) => {
      const next = new Set(previous);
      for (const file of visibleFiles) {
        if (allVisibleSelected) next.delete(file.key);
        else next.add(file.key);
      }
      return next;
    });
  };

  const saveScrollPosition = useCallback(
    (scrollTop: number) => {
      const key = `${selectedBucket}::${currentPrefix}`;
      tableScrollPositionsRef.current.set(key, scrollTop);
      lastScrollTopRef.current = scrollTop;
      lastScrollKeyRef.current = key;

      if (scrollPersistTimeoutRef.current !== null) {
        return;
      }

      scrollPersistTimeoutRef.current = window.setTimeout(() => {
        scrollPersistTimeoutRef.current = null;
        const latestKey = lastScrollKeyRef.current;
        const latestValue = lastScrollTopRef.current;

        if (!latestKey || typeof latestValue !== "number") {
          return;
        }

        window.sessionStorage.setItem(`object-scroll:${latestKey}`, String(latestValue));
      }, 100);
    },
    [currentPrefix, selectedBucket],
  );

  useEffect(() => {
    return () => {
      if (scrollPersistTimeoutRef.current !== null) {
        window.clearTimeout(scrollPersistTimeoutRef.current);
        scrollPersistTimeoutRef.current = null;
      }

      const latestKey = lastScrollKeyRef.current;
      const latestValue = lastScrollTopRef.current;

      if (latestKey && typeof latestValue === "number") {
        window.sessionStorage.setItem(`object-scroll:${latestKey}`, String(latestValue));
      }
    };
  }, []);

  const loadSavedScrollPosition = useCallback((key: string): number => {
    const inMemory = tableScrollPositionsRef.current.get(key);

    if (typeof inMemory === "number") {
      return inMemory;
    }

    const rawValue = window.sessionStorage.getItem(`object-scroll:${key}`);

    if (!rawValue) {
      return 0;
    }

    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : 0;
  }, []);
  const restoredScrollTop = useMemo(
    () => loadSavedScrollPosition(tableStateKey),
    [loadSavedScrollPosition, tableStateKey],
  );

  const handleTableScrollProgress = useCallback(
    (progress: number) => {
      if (
        !autoLoadOnScroll ||
        progress < 0.8 ||
        !canLoadMore ||
        objectsQuery.isFetchingNextPage ||
        prefetchInFlightRef.current
      ) {
        return;
      }

      prefetchInFlightRef.current = true;
      void objectsQuery.fetchNextPage().finally(() => {
        prefetchInFlightRef.current = false;
      });
    },
    [autoLoadOnScroll, canLoadMore, objectsQuery],
  );

  const navigateToPrefix = useCallback(
    (prefix: string) => {
      setCurrentPrefix(prefix);
      clearSearch();
      setSelectedObject(null);
      setPdfPreviewTarget(null);
    },
    [clearSearch],
  );

  const handleOpenFolder = useCallback(
    (key: string) => {
      const promptedKey = buildPromptedFolderKey(selectedBucket, key);

      if (shouldShowLargeFolderPrompt && !promptedFolderKeysRef.current.has(promptedKey)) {
        setPendingLargeFolderKey(key);
        return;
      }

      if (promptedFolderKeysRef.current.has(promptedKey)) {
        const storedLimit = promptedFolderLoadLimitsRef.current.get(promptedKey);
        setFolderLoadLimit(typeof storedLimit === "undefined" ? null : storedLimit);
      }

      navigateToPrefix(key);
    },
    [navigateToPrefix, selectedBucket, shouldShowLargeFolderPrompt],
  );

  const loginMutation = useMutation({
    mutationFn: ({
      accessKeyId,
      secretAccessKey,
    }: {
      accessKeyId: string;
      secretAccessKey: string;
    }) => login(accessKeyId, secretAccessKey),
    onSuccess: () => {
      queryClient.clear();
      setAuthScope(crypto.randomUUID());
      setIsAuthenticated(true);
      setAuthError(null);
    },
    onError: (error) => {
      setAuthError(error instanceof Error ? error.message : "登录验证失败");
    },
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      sessionGenerationRef.current += 1;
      for (const abort of uploadAbortMapRef.current.values()) abort();
      uploadAbortMapRef.current.clear();
      uploadPauseMapRef.current.clear();
      uploadSourceMapRef.current.clear();
      canceledUploadTaskIdsRef.current.clear();
      pausedUploadTaskIdsRef.current.clear();
      shareCacheRef.current.clear();
      latestUploadBatchIdsRef.current.clear();
      try {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith("atrium-resume-v2:")) window.localStorage.removeItem(key);
        }
      } catch {
        /* Local storage is optional. */
      }
      tableScrollPositionsRef.current.clear();
      promptedFolderKeysRef.current.clear();
      promptedFolderLoadLimitsRef.current.clear();
      setUploadTasks([]);
      setShareRequest(null);
      setSelectedFileKeys(new Set());
      setShareManagerOpen(false);
      void queryClient.cancelQueries();
      queryClient.clear();
      setAuthScope(crypto.randomUUID());
      setIsAuthenticated(false);
      setSelectedBucket("");
      setCurrentPrefix("");
      clearSearch();
      setSelectedObject(null);
      setIsPreviewOpen(false);
      setPdfPreviewTarget(null);
    },
  });

  const handleRefresh = async () => {
    setSelectedObject(null);
    setIsPreviewOpen(false);
    setPdfPreviewTarget(null);
    if (selectedBucket) await refreshObjectIndex(selectedBucket);
    await objectsQuery.refetch();
    await bucketsQuery.refetch();
  };

  const handleSelectFile = useCallback((file: SelectedObject) => {
    setSelectedObject(file);
    setIsPreviewOpen(true);
  }, []);

  const isPreviewVisible = isPreviewOpen && Boolean(selectedObject);
  const closePreview = useCallback(() => {
    shouldRestorePreviewToggleFocusRef.current = true;
    setIsPreviewOpen(false);
    setPdfPreviewTarget(null);
  }, []);
  useDialog(previewPanelRef, closePreview, compactLayout && isPreviewVisible);

  const handleOpenPdfPreview = useCallback(
    (file: SelectedObject) => {
      setPdfPreviewTarget(buildPdfPreviewTarget(selectedBucket, file));
    },
    [selectedBucket],
  );

  useEffect(() => {
    if (isPreviewVisible || !shouldRestorePreviewToggleFocusRef.current) {
      return;
    }

    // The mobile toggle is inside collapsed tools; use the file button restored by the dialog.
    if (!compactLayout) previewToggleButtonRef.current?.focus();
    shouldRestorePreviewToggleFocusRef.current = false;
  }, [isPreviewVisible, compactLayout]);

  useEffect(() => {
    if (!shouldClosePdfPreview(pdfPreviewTarget, selectedBucket, selectedObject, isPreviewOpen)) {
      return;
    }

    setPdfPreviewTarget(null);
  }, [isPreviewOpen, pdfPreviewTarget, selectedBucket, selectedObject]);

  const updateUploadTask = (taskId: string, updater: (task: UploadTask) => UploadTask): void => {
    setUploadTasks((prev) => prev.map((task) => (task.id === taskId ? updater(task) : task)));
  };

  const cancelUploadTask = (taskId: string): void => {
    canceledUploadTaskIdsRef.current.add(taskId);
    uploadAbortMapRef.current.get(taskId)?.();

    updateUploadTask(taskId, (task) => {
      if (task.status === "success" || task.status === "skipped") {
        return task;
      }

      return {
        ...task,
        status: "canceled",
        error: "已取消",
      };
    });
  };

  const cancelAllUploads = (): void => {
    setUploadTasks((prev) =>
      prev.map((task) => {
        if (
          task.status === "success" ||
          task.status === "skipped" ||
          task.status === "error" ||
          task.status === "canceled"
        ) {
          return task;
        }

        canceledUploadTaskIdsRef.current.add(task.id);
        uploadAbortMapRef.current.get(task.id)?.();

        return {
          ...task,
          status: "canceled",
          error: "已取消",
        };
      }),
    );
  };

  const ensureFolderPath = async (
    bucket: string,
    prefix: string,
    relativeFolderPath: string,
    createdFolders: Set<string>,
  ): Promise<void> => {
    const segments = splitPathSegments(relativeFolderPath);

    if (!segments.length) {
      return;
    }

    let cursor = prefix;

    for (const segment of segments) {
      const cacheKey = `${cursor}::${segment}`;

      if (!createdFolders.has(cacheKey)) {
        const response = await createFolder(bucket, cursor, segment);
        cursor = response.key;
        createdFolders.add(cacheKey);
      } else {
        cursor = `${cursor}${segment}/`;
      }
    }
  };

  const pauseUploadTask = (taskId: string): void => {
    pausedUploadTaskIdsRef.current.add(taskId);
    uploadPauseMapRef.current.get(taskId)?.();
    updateUploadTask(taskId, (task) =>
      task.status === "queued" || task.status === "uploading"
        ? { ...task, status: "paused", error: undefined, bytesPerSecond: 0 }
        : task,
    );
  };
  const clearFinishedUploads = (): void => {
    const finished = uploadTasks.filter(
      (task) =>
        task.status === "success" || task.status === "skipped" || task.status === "canceled",
    );
    for (const task of finished) {
      uploadSourceMapRef.current.delete(task.id);
      canceledUploadTaskIdsRef.current.delete(task.id);
      pausedUploadTaskIdsRef.current.delete(task.id);
    }
    setUploadTasks((previous) =>
      previous.filter((task) => !finished.some((item) => item.id === task.id)),
    );
  };

  const runUploadBatch = async (
    bucket: string,
    prefix: string,
    sourceFiles: UploadSourceFile[],
    emptyFolders: string[],
    isRetry = false,
    retryTaskIds: string[] = [],
  ): Promise<void> => {
    if (uploadBatchInFlightRef.current) {
      setGlobalError("另一批上传任务还在进行中");
      return;
    }

    const generation = sessionGenerationRef.current;
    const taskRecords = sourceFiles.map((source, index) => {
      const taskId = retryTaskIds[index] || crypto.randomUUID();
      const normalized = {
        ...source,
        relativePath: normalizeRelativePath(source.relativePath || source.file.name),
      };
      uploadSourceMapRef.current.set(taskId, normalized);
      canceledUploadTaskIdsRef.current.delete(taskId);
      pausedUploadTaskIdsRef.current.delete(taskId);
      const previous = uploadTasks.find((task) => task.id === taskId);
      return {
        id: taskId,
        filename: source.file.name,
        relativePath: normalized.relativePath,
        size: source.file.size,
        percent: previous?.percent || 0,
        status: "queued",
        bucket,
        prefix,
        conflict: previous?.conflict || uploadConflict,
      } satisfies UploadTask;
    });

    if (!taskRecords.length && !emptyFolders.length) {
      return;
    }

    uploadBatchInFlightRef.current = true;
    if (!isRetry) latestUploadBatchIdsRef.current = new Set();
    for (const task of taskRecords) latestUploadBatchIdsRef.current.add(task.id);
    setUploadTasks((prev) => [
      ...prev.filter((task) => !taskRecords.some((item) => item.id === task.id)),
      ...taskRecords,
    ]);
    setIsUploadingBatch(true);
    setGlobalError(null);

    try {
      const createdFolders = new Set<string>();

      for (const folderPath of Array.from(new Set(emptyFolders))) {
        await ensureFolderPath(bucket, prefix, folderPath, createdFolders);
      }

      const queue = taskRecords.map((task) => task.id);
      let activeCount = 0;

      await new Promise<void>((resolve) => {
        const launchNext = () => {
          while (activeCount < UPLOAD_CONCURRENCY && queue.length) {
            const taskId = queue.shift();

            if (!taskId) {
              continue;
            }

            if (
              canceledUploadTaskIdsRef.current.has(taskId) ||
              pausedUploadTaskIdsRef.current.has(taskId)
            ) {
              continue;
            }

            const source = uploadSourceMapRef.current.get(taskId);

            if (!source) {
              continue;
            }

            activeCount += 1;

            updateUploadTask(taskId, (task) => ({
              ...task,
              status: "uploading",
              percent: task.percent || 0,
              error: undefined,
            }));

            const request = uploadFile(
              bucket,
              prefix,
              source.file,
              source.relativePath,
              (percent) => {
                updateUploadTask(taskId, (task) => ({ ...task, percent }));
              },
              {
                conflict:
                  taskRecords.find((task) => task.id === taskId)?.conflict || uploadConflict,
                onMetrics: (metrics) =>
                  updateUploadTask(taskId, (task) => ({ ...task, ...metrics })),
              },
            );

            uploadAbortMapRef.current.set(taskId, request.abort);
            uploadPauseMapRef.current.set(taskId, request.pause);

            void request.promise
              .then((result) => {
                if (generation !== sessionGenerationRef.current) return;
                uploadSourceMapRef.current.delete(taskId);
                updateUploadTask(taskId, (task) => ({
                  ...task,
                  percent: 100,
                  status: result.skipped ? "skipped" : "success",
                  bytesPerSecond: 0,
                  etaSeconds: 0,
                  error: undefined,
                  key: result.key || undefined,
                  bucket,
                  lastModified: new Date().toISOString(),
                  contentType: source.file.type || undefined,
                }));
              })
              .catch((error: unknown) => {
                if (generation !== sessionGenerationRef.current) return;
                const isPaused = error instanceof Error && error.name === "PauseError";
                const isAbort =
                  error instanceof Error &&
                  (error.name === "AbortError" || error.message === "Upload canceled");

                updateUploadTask(taskId, (task) => ({
                  ...task,
                  status: isPaused ? "paused" : isAbort ? "canceled" : "error",
                  bytesPerSecond: 0,
                  error: isPaused
                    ? undefined
                    : isAbort
                      ? "已取消"
                      : error instanceof Error
                        ? error.message
                        : "上传失败",
                }));
              })
              .finally(() => {
                activeCount = Math.max(0, activeCount - 1);
                uploadAbortMapRef.current.delete(taskId);
                uploadPauseMapRef.current.delete(taskId);

                if (!queue.length && activeCount === 0) {
                  resolve();
                  return;
                }

                launchNext();
              });
          }

          if (!queue.length && activeCount === 0) {
            resolve();
          }
        };

        launchNext();
      });

      if (generation === sessionGenerationRef.current) await handleRefresh();
    } catch (error) {
      if (generation !== sessionGenerationRef.current) return;
      setGlobalError(error instanceof Error ? error.message : "上传失败");
    } finally {
      uploadBatchInFlightRef.current = false;
      if (generation === sessionGenerationRef.current) setIsUploadingBatch(false);
    }
  };

  const handleUploadSelection = async (selection: UploadSelection) => {
    if (!selectedBucket) {
      return;
    }

    await runUploadBatch(selectedBucket, currentPrefix, selection.files, selection.emptyFolders);
  };

  const retryUploadTask = async (taskId: string): Promise<void> => {
    if (!selectedBucket) {
      return;
    }

    const source = uploadSourceMapRef.current.get(taskId);

    if (!source) {
      return;
    }

    const originalTask = uploadTasks.find((task) => task.id === taskId);
    await runUploadBatch(
      originalTask?.bucket || selectedBucket,
      originalTask?.prefix ?? currentPrefix,
      [source],
      [],
      true,
      [taskId],
    );
  };
  const retryPendingUploads = async (): Promise<void> => {
    const pending = uploadTasks.filter(
      (task) => task.status === "error" || task.status === "paused",
    );
    const groups = new Map<string, UploadTask[]>();
    for (const task of pending) {
      const groupKey = JSON.stringify([task.bucket, task.prefix]);
      groups.set(groupKey, [...(groups.get(groupKey) || []), task]);
    }
    for (const tasks of groups.values()) {
      const available = tasks.filter((task) => uploadSourceMapRef.current.has(task.id));
      if (available.length)
        await runUploadBatch(
          available[0].bucket || selectedBucket,
          available[0].prefix || "",
          available.map((task) => uploadSourceMapRef.current.get(task.id)!),
          [],
          true,
          available.map((task) => task.id),
        );
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (target: DeleteTarget) => {
      if (!target || !selectedBucket) {
        return;
      }

      if (target.type === "file") {
        await deleteObject(selectedBucket, target.key);
      } else {
        await deletePrefix(selectedBucket, target.key);
      }
    },
    onSuccess: async () => {
      setDeleteTarget(null);
      await handleRefresh();
    },
    onError: (error) => {
      setGlobalError(error instanceof Error ? error.message : "删除失败");
    },
  });

  const createFolderMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!selectedBucket) {
        throw new Error("请先选择存储桶");
      }

      return createFolder(selectedBucket, currentPrefix, name);
    },
    onSuccess: (response) => {
      setCurrentPrefix(response.key);
      clearSearch();
      setSelectedObject(null);
      setCreateFolderOpen(false);
      void handleRefresh();
    },
    onError: (error) => {
      setGlobalError(error instanceof Error ? error.message : "创建文件夹失败");
    },
  });

  const statusText = useMemo(() => {
    if (isSearchDebouncing) {
      return "正在准备搜索...";
    }

    if (isSorting) {
      return "正在排序...";
    }

    return null;
  }, [isSearchDebouncing, isSorting]);

  const objectsErrorMessage = useMemo(() => {
    if (!objectsQuery.isError) {
      return null;
    }

    return objectsQuery.error instanceof Error ? objectsQuery.error.message : "加载目录列表失败。";
  }, [objectsQuery.error, objectsQuery.isError]);

  const uploadSummary = useMemo(() => {
    if (!uploadTasks.length) {
      return null;
    }

    const totalBytes = uploadTasks.reduce((sum, task) => sum + task.size, 0);
    const uploadedBytes = uploadTasks.reduce((sum, task) => {
      return sum + Math.floor((task.size * task.percent) / 100);
    }, 0);
    const doneCount = uploadTasks.filter(
      (task) => task.status === "success" || task.status === "skipped",
    ).length;
    const errorCount = uploadTasks.filter((task) => task.status === "error").length;
    const canceledCount = uploadTasks.filter((task) => task.status === "canceled").length;
    const activeCount = uploadTasks.filter(
      (task) => task.status === "uploading" || task.status === "queued",
    ).length;

    const overallPercent = totalBytes === 0 ? 100 : Math.round((uploadedBytes / totalBytes) * 100);

    return {
      overallPercent,
      doneCount,
      errorCount,
      canceledCount,
      activeCount,
      totalCount: uploadTasks.length,
    };
  }, [uploadTasks]);

  if (authLoading) {
    return (
      <div className="centered">
        <div className="center-feedback">
          <span className="spinner" aria-hidden="true" />
          <p>正在加载会话...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <LoginForm
        isLoading={loginMutation.isPending}
        error={authError}
        onSubmit={async (accessKeyId, secretAccessKey) =>
          loginMutation.mutateAsync({ accessKeyId, secretAccessKey })
        }
      />
    );
  }

  return (
    <div className={isPreviewVisible ? "layout layout-with-preview" : "layout"}>
      <aside className="sidebar" aria-label="存储桶导航" inert={compactLayout && isPreviewVisible}>
        <div className="sidebar-header">
          <h2>存储桶</h2>
          <button type="button" onClick={() => void bucketsQuery.refetch()}>
            刷新
          </button>
        </div>
        <div className="bucket-list">
          {bucketsQuery.data?.map((bucket) => (
            <button
              key={bucket}
              type="button"
              className={bucket === selectedBucket ? "bucket active" : "bucket"}
              onClick={() => {
                setSelectedBucket(bucket);
                setCurrentPrefix("");
                setFolderLoadLimit(null);
                clearSearch();
                setSelectedObject(null);
                setIsPreviewOpen(false);
                setPdfPreviewTarget(null);
              }}
            >
              {bucket}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setShareManagerOpen(true)}>
          我的分享
        </button>
        <button type="button" className="logout" onClick={() => logoutMutation.mutate()}>
          退出登录
        </button>
      </aside>

      <main className="main-panel" inert={compactLayout && isPreviewVisible}>
        <header className="toolbar">
          <div className="toolbar-location">
            <h1>对象浏览器</h1>
            <Breadcrumbs
              bucket={selectedBucket}
              prefix={currentPrefix}
              onNavigate={(prefix) => {
                setFolderLoadLimit(null);
                navigateToPrefix(prefix);
              }}
            />
            {folderHealthLabel ? (
              <p className="toolbar-note warning-text">{folderHealthLabel}</p>
            ) : null}
          </div>
          <div className="toolbar-actions">
            <input
              className="file-search"
              type="search"
              aria-label="按名称筛选文件"
              value={searchInput}
              placeholder="按名称筛选"
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <button
              type="button"
              onClick={() => setCreateFolderOpen(true)}
              disabled={!selectedBucket}
            >
              新建文件夹
            </button>
            <button type="button" onClick={() => void handleRefresh()}>
              刷新文件
            </button>
            <details
              className="browser-tools"
              open={!mobileLayout || toolsExpanded}
              onToggle={(event) => {
                if (mobileLayout) setToolsExpanded(event.currentTarget.open);
              }}
            >
              <summary>筛选与显示</summary>
              <div className="browser-tools-content">
                <button
                  type="button"
                  className="preview-toggle"
                  ref={previewToggleButtonRef}
                  onClick={() => {
                    if (isPreviewVisible) {
                      closePreview();
                      return;
                    }

                    if (selectedObject) {
                      setIsPreviewOpen(true);
                    }
                  }}
                  disabled={!selectedObject}
                  aria-controls={isPreviewVisible ? "object-preview" : undefined}
                  aria-expanded={isPreviewVisible}
                >
                  {isPreviewVisible ? "隐藏预览" : "显示预览"}
                </button>
                <label className="auto-load-toggle">
                  <input
                    type="checkbox"
                    checked={autoLoadOnScroll}
                    onChange={(event) => setAutoLoadOnScroll(event.target.checked)}
                  />
                  <span>滚动时自动加载</span>
                </label>
                <select
                  aria-label="文件排序"
                  value={sortMode}
                  onChange={(event) => {
                    const nextSort = event.target.value;
                    if (isSortMode(nextSort)) setSortMode(nextSort);
                  }}
                >
                  <option value="name-asc">名称（A-Z）</option>
                  <option value="name-desc">名称(Z-A)</option>
                  <option value="size-asc">大小(从小到大)</option>
                  <option value="size-desc">大小(从大到小)</option>
                  <option value="modified-asc">上传时间（最早在前）</option>
                  <option value="modified-desc">上传时间（最新在前）</option>
                </select>
              </div>
            </details>
          </div>
        </header>

        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <label>
            同名文件：
            <select
              value={uploadConflict}
              onChange={(event) =>
                setUploadConflict(event.target.value as "keep-both" | "skip" | "replace")
              }
              disabled={isUploadingBatch}
            >
              <option value="keep-both">保留两份（推荐）</option>
              <option value="skip">跳过同名文件</option>
              <option value="replace">替换原文件</option>
            </select>
          </label>
          <span className="muted">支持分片续传。刷新后重新选择同一个文件即可继续。</span>
        </div>
        <UploadDropzone
          disabled={!selectedBucket || isUploadingBatch}
          onSelection={handleUploadSelection}
        />

        {uploadSummary ? (
          <div className="upload-list">
            <div className="upload-summary">
              <strong>
                上传:{uploadSummary.overallPercent}%({uploadSummary.doneCount}/
                {uploadSummary.totalCount})
              </strong>
              <span>
                进行中 {uploadSummary.activeCount} · 失败 {uploadSummary.errorCount} · 已取消{" "}
                {uploadSummary.canceledCount}
              </span>
              <div className="upload-summary-actions">
                {uploadedShareFiles.length ? (
                  <button
                    type="button"
                    disabled={isUploadingBatch}
                    onClick={() => openShare(uploadedShareFiles, "本批上传的文件")}
                  >
                    {isUploadingBatch
                      ? "上传完成后分享本批文件"
                      : `复制本批成功文件短链（${uploadedShareFiles.length} 个）`}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    uploadTasks
                      .filter((task) => task.status === "uploading" || task.status === "queued")
                      .forEach((task) => pauseUploadTask(task.id))
                  }
                  disabled={!isUploadingBatch}
                >
                  全部暂停
                </button>
                <button
                  type="button"
                  onClick={() => void retryPendingUploads()}
                  disabled={
                    isUploadingBatch ||
                    !uploadTasks.some((task) => task.status === "error" || task.status === "paused")
                  }
                >
                  继续／重试失败
                </button>
                <button type="button" onClick={clearFinishedUploads}>
                  清理完成
                </button>
                <button type="button" onClick={() => setShowUploadHistory((value) => !value)}>
                  {showUploadHistory ? "收起任务" : "展开任务"}
                </button>
                <button type="button" onClick={cancelAllUploads} disabled={!isUploadingBatch}>
                  全部取消
                </button>
              </div>
            </div>

            {(showUploadHistory
              ? uploadTasks.slice(-100)
              : uploadTasks
                  .filter(
                    (task) =>
                      task.status === "uploading" ||
                      task.status === "queued" ||
                      task.status === "error" ||
                      task.status === "paused",
                  )
                  .slice(-20)
            ).map((item) => (
              <div key={item.id} className="upload-item">
                <div className="upload-item-main">
                  <span className="upload-item-path">{item.relativePath}</span>
                  <span>
                    {item.percent}% · {UPLOAD_STATUS_LABELS[item.status] ?? item.status}
                    {item.status === "uploading" && item.bytesPerSecond
                      ? ` · ${(item.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s · 约 ${Math.ceil(item.etaSeconds || 0)} 秒`
                      : ""}
                  </span>
                </div>
                <div className="upload-item-actions">
                  {item.status === "queued" || item.status === "uploading" ? (
                    <button type="button" onClick={() => pauseUploadTask(item.id)}>
                      暂停
                    </button>
                  ) : null}
                  {item.status === "queued" ||
                  item.status === "uploading" ||
                  item.status === "paused" ? (
                    <button type="button" onClick={() => cancelUploadTask(item.id)}>
                      取消
                    </button>
                  ) : null}
                  {item.status === "error" ||
                  item.status === "paused" ||
                  item.status === "canceled" ? (
                    <button
                      type="button"
                      onClick={() => void retryUploadTask(item.id)}
                      disabled={isUploadingBatch}
                    >
                      {item.status === "paused" ? "继续" : "重试"}
                    </button>
                  ) : null}
                  {item.error ? <span className="upload-item-error">{item.error}</span> : null}
                </div>
              </div>
            ))}
            <p className="muted">为保持流畅，展开后最多显示最近 100 个任务，统计覆盖全部任务。</p>
          </div>
        ) : null}

        <div className="content-panel">
          {objectsErrorMessage ? (
            <div className="center-feedback error-banner" role="alert">
              <p>{objectsErrorMessage}</p>
            </div>
          ) : null}

          {!objectsErrorMessage && statusText ? (
            <div className="center-feedback status-banner" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <p>{statusText}</p>
            </div>
          ) : null}

          {!objectsErrorMessage && (objectsData || objectsQuery.isLoading) ? (
            <>
              {shareBaseUrlForTable ? (
                <div className="selection-toolbar" aria-label="批量分享">
                  <label>
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleFiles.length}
                      onChange={toggleVisibleSelection}
                    />
                    全选筛选结果
                  </label>
                  <span className="selection-count">已选 {selectedFiles.length} 个文件</span>
                  <button
                    type="button"
                    className="selection-share"
                    disabled={!selectedFiles.length}
                    onClick={() => openShare(selectedFiles)}
                  >
                    复制分享短链
                  </button>
                  {selectedFiles.length ? (
                    <button type="button" onClick={() => setSelectedFileKeys(new Set())}>
                      清空选择
                    </button>
                  ) : null}
                </div>
              ) : null}
              <ObjectTable
                folders={sortedObjects?.folders ?? []}
                files={sortedObjects?.files ?? []}
                filter={filter}
                loadingMore={objectsQuery.isFetchingNextPage}
                scrollStateKey={tableStateKey}
                initialScrollTop={restoredScrollTop}
                isInitialLoading={objectsQuery.isLoading}
                shareBaseUrl={shareBaseUrlForTable}
                selectedFileKeys={selectedFileKeys}
                onToggleFileSelection={toggleFileSelection}
                onShareFile={(file) => openShare([file])}
                onScrollProgress={handleTableScrollProgress}
                onScrollPositionChange={saveScrollPosition}
                onOpenFolder={handleOpenFolder}
                onSelectFile={handleSelectFile}
                onDeleteFolder={(key) => setDeleteTarget({ type: "folder", key })}
                onDeleteFile={(key) => setDeleteTarget({ type: "file", key })}
                onDownloadFile={(key) => {
                  window.open(getDownloadUrl(selectedBucket, key), "_blank");
                }}
              />
              {loadedObjectsLabel ? (
                <div className="table-progress" aria-live="polite">
                  {loadedObjectsLabel}
                </div>
              ) : null}
              {searchLimitWarning ? (
                <div className="table-progress warning-text" role="status">
                  {searchLimitWarning}
                </div>
              ) : null}
              {sortWarning ? (
                <div className="table-progress warning-text" role="status">
                  {sortWarning}
                </div>
              ) : null}
              {folderLoadLimit !== null ? (
                <div className="table-progress" role="status">
                  限量模式:只加载前 {folderLoadLimit.toLocaleString()} 个对象。
                  <button type="button" onClick={() => setFolderLoadLimit(null)}>
                    全部加载并排序
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {!statusText && !objectsErrorMessage && canLoadMore ? (
            <>
              <div className="table-pagination">
                <button
                  type="button"
                  onClick={() => void objectsQuery.fetchNextPage()}
                  disabled={objectsQuery.isFetchingNextPage}
                >
                  {objectsQuery.isFetchingNextPage ? "正在加载更多..." : "加载更多"}
                </button>
              </div>
              <div className="table-pagination-sentinel" aria-hidden="true" />
            </>
          ) : null}

          {globalError ? (
            <div className="center-overlay" role="alert">
              <div className="center-feedback error-banner">
                <p>{globalError}</p>
                <button type="button" onClick={() => setGlobalError(null)}>
                  关闭
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      {isPreviewVisible ? (
        <section
          id="object-preview"
          className="preview-column"
          ref={previewPanelRef}
          role={compactLayout ? "dialog" : undefined}
          aria-modal={compactLayout ? true : undefined}
          aria-labelledby="object-preview-title"
          tabIndex={-1}
          inert={Boolean(pdfPreviewTarget)}
        >
          <div className="preview-column-header">
            <h2 id="object-preview-title">文件预览</h2>
            <button type="button" onClick={closePreview}>
              关闭预览
            </button>
          </div>
          <FilePreview
            bucket={selectedBucket}
            file={selectedObject}
            enableS3UriCopy={runtimeConfigQuery.data?.features?.enableS3UriCopy ?? false}
            onOpenPdfPreview={handleOpenPdfPreview}
          />
        </section>
      ) : null}

      {pendingLargeFolderKey ? (
        <Dialog labelledBy="large-folder-title" onClose={() => setPendingLargeFolderKey(null)}>
          <div className="modal-card">
            <h3 id="large-folder-title">大目录提醒</h3>
            <p>
              该存储桶预计有{" "}
              {(bucketSizeQuery.data?.objectCount ?? loadedObjectCount).toLocaleString()} 个对象,
              全部加载可能较慢。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  const promptedKey = buildPromptedFolderKey(selectedBucket, pendingLargeFolderKey);
                  promptedFolderKeysRef.current.add(promptedKey);
                  promptedFolderLoadLimitsRef.current.set(promptedKey, 1000);
                  setFolderLoadLimit(1000);
                  navigateToPrefix(pendingLargeFolderKey);
                  setPendingLargeFolderKey(null);
                }}
              >
                只加载前 1,000 个
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const promptedKey = buildPromptedFolderKey(selectedBucket, pendingLargeFolderKey);
                  promptedFolderKeysRef.current.add(promptedKey);
                  promptedFolderLoadLimitsRef.current.set(promptedKey, null);
                  setFolderLoadLimit(null);
                  navigateToPrefix(pendingLargeFolderKey);
                  setPendingLargeFolderKey(null);
                }}
              >
                全部加载
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingLargeFolderKey(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {shareRequest ? (
        <ShareDialog
          key={shareRequest.cacheKey}
          bucket={shareRequest.bucket}
          files={shareRequest.files}
          initialTitle={shareRequest.title}
          existing={shareCacheRef.current.get(shareRequest.cacheKey)}
          onCreated={cacheCreatedShare}
          onClose={() => setShareRequest(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={deleteTarget.type === "file" ? "删除文件" : "删除文件夹"}
          message={
            deleteTarget.type === "file"
              ? `确定删除文件「${deleteTarget.key}」吗?`
              : `确定删除文件夹「${deleteTarget.key}」及其全部内容吗?`
          }
          isLoading={deleteMutation.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => deleteMutation.mutateAsync(deleteTarget)}
        />
      ) : null}

      {createFolderOpen ? (
        <CreateFolderDialog
          bucket={selectedBucket}
          prefix={currentPrefix}
          isLoading={createFolderMutation.isPending}
          onCancel={() => setCreateFolderOpen(false)}
          onCreate={async (name) => {
            await createFolderMutation.mutateAsync(name);
          }}
        />
      ) : null}

      {pdfPreviewTarget ? (
        <Suspense
          fallback={
            <Dialog
              className="pdf-preview-overlay"
              labelledBy="pdf-preview-loading-title"
              onClose={() => setPdfPreviewTarget(null)}
            >
              <div className="modal-card pdf-preview-dialog">
                <div
                  className="center-feedback status-banner pdf-preview-loading-shell"
                  aria-live="polite"
                >
                  <span className="spinner" aria-hidden="true" />
                  <p id="pdf-preview-loading-title">正在加载 PDF 阅读器...</p>
                  <button type="button" onClick={() => setPdfPreviewTarget(null)}>
                    关闭阅读器
                  </button>
                </div>
              </div>
            </Dialog>
          }
        >
          <PdfPreview
            key={pdfPreviewTarget.fileKey}
            bucket={pdfPreviewTarget.bucket}
            fileKey={pdfPreviewTarget.fileKey}
            fileName={pdfPreviewTarget.fileName}
            onClose={() => {
              setPdfPreviewTarget(null);
            }}
          />
        </Suspense>
      ) : null}
      {shareManagerOpen ? (
        <Dialog labelledBy="share-manager-title" onClose={() => setShareManagerOpen(false)}>
          <ShareManager onClose={() => setShareManagerOpen(false)} />
        </Dialog>
      ) : null}
    </div>
  );
};
