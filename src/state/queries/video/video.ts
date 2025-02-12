import React, {useCallback} from 'react'
import {ImagePickerAsset} from 'expo-image-picker'
import {AppBskyVideoDefs, BlobRef} from '@atproto/api'
import {msg} from '@lingui/macro'
import {useLingui} from '@lingui/react'
import {QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'

import {SUPPORTED_MIME_TYPES, SupportedMimeTypes} from '#/lib/constants'
import {logger} from '#/logger'
import {isWeb} from '#/platform/detection'
import {ServerError, VideoTooLargeError} from 'lib/media/video/errors'
import {CompressedVideo} from 'lib/media/video/types'
import {useCompressVideoMutation} from 'state/queries/video/compress-video'
import {useVideoAgent} from 'state/queries/video/util'
import {useUploadVideoMutation} from 'state/queries/video/video-upload'

type Status = 'idle' | 'compressing' | 'processing' | 'uploading' | 'done'

type Action =
  | {type: 'SetStatus'; status: Status}
  | {type: 'SetProgress'; progress: number}
  | {type: 'SetError'; error: string | undefined}
  | {type: 'Reset'}
  | {type: 'SetAsset'; asset: ImagePickerAsset}
  | {type: 'SetDimensions'; width: number; height: number}
  | {type: 'SetVideo'; video: CompressedVideo}
  | {type: 'SetJobStatus'; jobStatus: AppBskyVideoDefs.JobStatus}
  | {type: 'SetBlobRef'; blobRef: BlobRef}

export interface State {
  status: Status
  progress: number
  asset?: ImagePickerAsset
  video: CompressedVideo | null
  jobStatus?: AppBskyVideoDefs.JobStatus
  blobRef?: BlobRef
  error?: string
  abortController: AbortController
}

function reducer(queryClient: QueryClient) {
  return (state: State, action: Action): State => {
    let updatedState = state
    if (action.type === 'SetStatus') {
      updatedState = {...state, status: action.status}
    } else if (action.type === 'SetProgress') {
      updatedState = {...state, progress: action.progress}
    } else if (action.type === 'SetError') {
      updatedState = {...state, error: action.error}
    } else if (action.type === 'Reset') {
      state.abortController.abort()
      queryClient.cancelQueries({
        queryKey: ['video'],
      })
      updatedState = {
        status: 'idle',
        progress: 0,
        video: null,
        blobRef: undefined,
        abortController: new AbortController(),
      }
    } else if (action.type === 'SetAsset') {
      updatedState = {
        ...state,
        asset: action.asset,
        status: 'compressing',
        error: undefined,
      }
    } else if (action.type === 'SetDimensions') {
      updatedState = {
        ...state,
        asset: state.asset
          ? {...state.asset, width: action.width, height: action.height}
          : undefined,
      }
    } else if (action.type === 'SetVideo') {
      updatedState = {...state, video: action.video, status: 'uploading'}
    } else if (action.type === 'SetJobStatus') {
      updatedState = {...state, jobStatus: action.jobStatus}
    } else if (action.type === 'SetBlobRef') {
      updatedState = {...state, blobRef: action.blobRef, status: 'done'}
    }
    return updatedState
  }
}

export function useUploadVideo({
  setStatus,
  onSuccess,
}: {
  setStatus: (status: string) => void
  onSuccess: () => void
}) {
  const {_} = useLingui()
  const queryClient = useQueryClient()
  const [state, dispatch] = React.useReducer(reducer(queryClient), {
    status: 'idle',
    progress: 0,
    video: null,
    abortController: new AbortController(),
  })

  const {setJobId} = useUploadStatusQuery({
    onStatusChange: (status: AppBskyVideoDefs.JobStatus) => {
      // This might prove unuseful, most of the job status steps happen too quickly to even be displayed to the user
      // Leaving it for now though
      dispatch({
        type: 'SetJobStatus',
        jobStatus: status,
      })
      setStatus(status.state.toString())
    },
    onSuccess: blobRef => {
      dispatch({
        type: 'SetBlobRef',
        blobRef,
      })
      onSuccess()
    },
  })

  const {mutate: onVideoCompressed} = useUploadVideoMutation({
    onSuccess: response => {
      dispatch({
        type: 'SetStatus',
        status: 'processing',
      })
      setJobId(response.jobId)
    },
    onError: e => {
      if (e instanceof ServerError) {
        dispatch({
          type: 'SetError',
          error: e.message,
        })
      } else {
        dispatch({
          type: 'SetError',
          error: _(msg`An error occurred while uploading the video.`),
        })
      }
      logger.error('Error uploading video', {safeMessage: e})
    },
    setProgress: p => {
      dispatch({type: 'SetProgress', progress: p})
    },
    signal: state.abortController.signal,
  })

  const {mutate: onSelectVideo} = useCompressVideoMutation({
    onProgress: p => {
      dispatch({type: 'SetProgress', progress: p})
    },
    onSuccess: (video: CompressedVideo) => {
      dispatch({
        type: 'SetVideo',
        video,
      })
      onVideoCompressed(video)
    },
    onError: e => {
      if (e instanceof VideoTooLargeError) {
        dispatch({
          type: 'SetError',
          error: _(msg`The selected video is larger than 100MB.`),
        })
      } else {
        dispatch({
          type: 'SetError',
          error: _(msg`An error occurred while compressing the video.`),
        })
        logger.error('Error compressing video', {safeMessage: e})
      }
    },
    signal: state.abortController.signal,
  })

  const selectVideo = (asset: ImagePickerAsset) => {
    // compression step on native converts to mp4, so no need to check there
    if (isWeb) {
      const mimeType = getMimeType(asset)
      if (!SUPPORTED_MIME_TYPES.includes(mimeType as SupportedMimeTypes)) {
        throw new Error(_(msg`Unsupported video type: ${mimeType}`))
      }
    }

    dispatch({
      type: 'SetAsset',
      asset,
    })
    onSelectVideo(asset)
  }

  const clearVideo = () => {
    dispatch({type: 'Reset'})
  }

  const updateVideoDimensions = useCallback((width: number, height: number) => {
    dispatch({
      type: 'SetDimensions',
      width,
      height,
    })
  }, [])

  return {
    state,
    dispatch,
    selectVideo,
    clearVideo,
    updateVideoDimensions,
  }
}

const useUploadStatusQuery = ({
  onStatusChange,
  onSuccess,
}: {
  onStatusChange: (status: AppBskyVideoDefs.JobStatus) => void
  onSuccess: (blobRef: BlobRef) => void
}) => {
  const videoAgent = useVideoAgent()
  const [enabled, setEnabled] = React.useState(true)
  const [jobId, setJobId] = React.useState<string>()

  const {isLoading, isError} = useQuery({
    queryKey: ['video', 'upload status', jobId],
    queryFn: async () => {
      if (!jobId) return // this won't happen, can ignore

      const {data} = await videoAgent.app.bsky.video.getJobStatus({jobId})
      const status = data.jobStatus
      if (status.state === 'JOB_STATE_COMPLETED') {
        setEnabled(false)
        if (!status.blob)
          throw new Error('Job completed, but did not return a blob')
        onSuccess(status.blob)
      } else if (status.state === 'JOB_STATE_FAILED') {
        throw new Error('Job failed to process')
      }
      onStatusChange(status)
      return status
    },
    enabled: Boolean(jobId && enabled),
    refetchInterval: 1500,
  })

  return {
    isLoading,
    isError,
    setJobId: (_jobId: string) => {
      setJobId(_jobId)
      setEnabled(true)
    },
  }
}

function getMimeType(asset: ImagePickerAsset) {
  if (isWeb) {
    const [mimeType] = asset.uri.slice('data:'.length).split(';base64,')
    if (!mimeType) {
      throw new Error('Could not determine mime type')
    }
    return mimeType
  }
  if (!asset.mimeType) {
    throw new Error('Could not determine mime type')
  }
  return asset.mimeType
}
