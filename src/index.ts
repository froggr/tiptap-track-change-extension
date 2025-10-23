import { ReplaceStep, Step } from '@tiptap/pm/transform'
import { TextSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Slice, Fragment } from '@tiptap/pm/model'
import {Extension, Mark, getMarkRange, getMarksBetween, isMarkActive, mergeAttributes} from '@tiptap/core'
import type { CommandProps, Editor, MarkRange} from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'

const LOG_ENABLED = true

export const MARK_DELETION = 'deletion'
export const MARK_INSERTION = 'insertion'
export const EXTENSION_NAME = 'trackchange'

// Track Change Operations
export const TRACK_COMMAND_ACCEPT = 'accept'
export const TRACK_COMMAND_ACCEPT_ALL = 'accept-all'
export const TRACK_COMMAND_REJECT = 'reject'
export const TRACK_COMMAND_REJECT_ALL = 'reject-all'

export type TRACK_COMMAND_TYPE = 'accept' | 'accept-all' | 'reject' | 'reject-all'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackchange: {
      /**
       * change track change extension enabled status
       * we don't use a external function instead，so we can use a editor.command anywhere without another variable
       * @param enabled
       * @returns 
       */
      setTrackChangeStatus: (enabled: boolean) => ReturnType,
      getTrackChangeStatus: () => ReturnType,
      toggleTrackChangeStatus: () => ReturnType,
      /**
       * accept one change: auto recognize the selection or left near by cursor pos
       */
      acceptChange: () => ReturnType, 
      /**
       * accept all changes: mark insertion as normal, and remove all the deletion nodes
       */
      acceptAllChanges: () => ReturnType, 
      /**
       * same to accept
       */
      rejectChange: () => ReturnType, 
      /**
       * same to acceptAll but: remove deletion mark and remove all insertion nodes
       */
      rejectAllChanges: () => ReturnType, 
      /**
       * 
       */
      updateOpUserOption: (opUserId: string, opUserNickname: string) => ReturnType
    }
  }
}

// insert mark
export const InsertionMark = Mark.create({
  name: MARK_INSERTION,
  addAttributes () {
    return {
      'data-op-user-id': {
        type: 'string',
        default: () => '',
      },
      'data-op-user-nickname': {
        type: 'string',
        default: () => '',
      },
      'data-op-date': {
        type: 'string',
        default: () => '',
      }
    }
  },
  parseHTML () {
    return [
      { tag: 'insert' }
    ]
  },
  renderHTML ({ HTMLAttributes }) {
    return ['insert', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  }
})

// delete mark
export const DeletionMark = Mark.create({
  name: MARK_DELETION,
  addAttributes () {
    return {
      'data-op-user-id': {
        type: 'string',
        default: () => '',
      },
      'data-op-user-nickname': {
        type: 'string',
        default: () => '',
      },
      'data-op-date': {
        type: 'string',
        default: () => '',
      }
    }
  },
  parseHTML () {
    return [
      { tag: 'delete' }
    ]
  },
  renderHTML ({ HTMLAttributes }) {
    return ['delete', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  }
})

// save the ime-mode status, when input chinese char, the extension needs to deal the change with a special strategy 
// TODO: Is it necessary to save these two variable into a tiptap instance when someone open two editor
const IME_STATUS_NORMAL = 0
const IME_STATUS_START = 1
const IME_STATUS_CONTINUE = 2
const IME_STATUS_FINISHED = 3
type IME_STATUS_TYPE = 0 | 1 | 2 | 3
let composingStatus: IME_STATUS_TYPE = 0 // 0: normal，1: start with first chat, 2: continue input, 3: finished by confirm or cancel with chars applied
let isStartChineseInput = false

// get self extension instance by name
const getSelfExt = (editor: Editor) => editor.extensionManager.extensions.find(item => item.type === 'extension' && item.name === EXTENSION_NAME) as Extension

// get the current minute time, avoid two char with different time splitted with too many marks
const getMinuteTime = () => Math.round(new Date().getTime() / 1000 / 60) * 1000 * 60

/**
 * accept or reject tracked changes for all content or just the selection
 * @param opType operation to apply
 * @param param a command props, so we can get the editor, tr prop
 * @returns null
 */
const changeTrack = (opType: TRACK_COMMAND_TYPE, param: CommandProps) => {
  /**
   * get the range to deal, use selection default
   */
  const from = param.editor.state.selection.from
  const to = param.editor.state.selection.to
  /**
   * find all the mark ranges to deal and remove mark or remove content according by opType
   * if got accept all or reject all, just set 'from' to 0 and 'to' to content size
   * if got just a part range, 
   */
  let markRanges: Array<MarkRange> = []
  /**
   * deal a part and no selection contents, need to recognize the left mark near by cursor
   */
  if ((opType === TRACK_COMMAND_ACCEPT || opType === TRACK_COMMAND_REJECT) && from === to) {
    // detect left mark
    const isInsertBeforeCursor = isMarkActive(param.editor.state, MARK_INSERTION)
    const isDeleteBeforeCursor = isMarkActive(param.editor.state, MARK_DELETION)
    let leftRange
    if (isInsertBeforeCursor) {
      leftRange = getMarkRange(param.editor.state.selection.$from, param.editor.state.doc.type.schema.marks.insertion)
    } else if (isDeleteBeforeCursor) {
      leftRange = getMarkRange(param.editor.state.selection.$from, param.editor.state.doc.type.schema.marks.deletion)
    }
    if (leftRange) {
      markRanges = getMarksBetween(leftRange.from, leftRange.to, param.editor.state.doc)
    }
  } else if (opType === TRACK_COMMAND_ACCEPT_ALL || opType === TRACK_COMMAND_REJECT_ALL) {
    // all editor content
    markRanges = getMarksBetween(0, param.editor.state.doc.content.size, param.editor.state.doc)
    // change the opType to normal
    opType = opType === TRACK_COMMAND_ACCEPT_ALL ? TRACK_COMMAND_ACCEPT : TRACK_COMMAND_REJECT 
  } else {
    // just the selection
    markRanges = getMarksBetween(from, to, param.editor.state.doc)
  }
  // just deal the track change nodes
  markRanges = markRanges.filter(markRange => markRange.mark.type.name === MARK_DELETION || markRange.mark.type.name === MARK_INSERTION)
  if (!markRanges.length) { return false }

  const currentTr = param.tr
  /**
   * mark type and opType compose:
   * 1. accept with insert mark: remove insert mark
   * 2. accept with delete mark: remove content
   * 3. reject with insert mark: remove content
   * 4. reject with delete mark: remove delete mark
   * so
   * 1 and 4 need to remove mark
   * 2 and 3 need to remove content
   */
  // record offset when delete some content to find the correct pos for next range
  let offset = 0
  const removeInsertMark = param.editor.state.doc.type.schema.marks.insertion.create()
  const removeDeleteMark = param.editor.state.doc.type.schema.marks.deletion.create()
  markRanges.forEach((markRange) => {
    const isAcceptInsert = opType === TRACK_COMMAND_ACCEPT && markRange.mark.type.name === MARK_INSERTION
    const isRejectDelete = opType === TRACK_COMMAND_REJECT && markRange.mark.type.name === MARK_DELETION
    if (isAcceptInsert || isRejectDelete) {
      // 1 and 4: remove mark
      currentTr.removeMark(markRange.from - offset, markRange.to - offset, removeInsertMark.type)
      currentTr.removeMark(markRange.from - offset, markRange.to - offset, removeDeleteMark.type)
    } else {
      // 2 and 3 remove content
      currentTr.deleteRange(markRange.from - offset, markRange.to - offset)
      // change the offset
      offset += (markRange.to - markRange.from)
    }
  })
  if (currentTr.steps.length) {
    // set a custom meta to tell our TrackChangeExtension to ignore this change
    currentTr.setMeta('trackManualChanged', true)
  }
  return true
}

// @ts-ignore
/**
 * TODO: some problems to fix or feature to implement
 * 1. when delete content includes two and more paragraphs, cannot mark the new paragraph as insert mark, because the mark is inline, can we add global attrs?
 * 2. when delete content includes two and more paragraphs, connot ignore the insert mark inside the content. Currently, the insert mark is marked as deleted. But it need to be delete directly.
 * 3. select two chars and inout a chinese char, the new char was input with wrong position. (fixed by stop input action)
 * 4. how to toggle to "hide" mode and can record the change ranges too, just look likes the office word
 */
export const TrackChangeExtension = Extension.create<{ enabled: boolean, onStatusChange?: Function, dataOpUserId?: string, dataOpUserNickname?: string }>({
  name: EXTENSION_NAME,
  onCreate () {
    if (this.options.onStatusChange) {
      this.options.onStatusChange(this.options.enabled)
    }
  },
  addExtensions () {
    return [InsertionMark, DeletionMark]
  },
  addCommands: () => {
    return {
      setTrackChangeStatus: (enabled: boolean) => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor)
        thisExtension.options.enabled = enabled
        if (thisExtension.options.onStatusChange) {
          thisExtension.options.onStatusChange(thisExtension.options.enabled)
        }
        return false
      },
      toggleTrackChangeStatus: () => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor)
        thisExtension.options.enabled = !thisExtension.options.enabled
        if (thisExtension.options.onStatusChange) {
          thisExtension.options.onStatusChange(thisExtension.options.enabled)
        }
        return false
      },
      getTrackChangeStatus: () => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor)
        return thisExtension.options.enabled
      },
      acceptChange: () => (param: CommandProps) => {
        changeTrack('accept', param)
        return false
      },
      acceptAllChanges: () => (param: CommandProps) => {
        changeTrack('accept-all', param)
        return false
      },
      rejectChange: () => (param: CommandProps) => {
        changeTrack('reject', param)
        return false
        
      },
      rejectAllChanges: () => (param: CommandProps) => {
        changeTrack('reject-all', param)
        return false
      },
      updateOpUserOption: (opUserId: string, opUserNickname: string) => (param: CommandProps) => {
        const thisExtension = getSelfExt(param.editor)
        thisExtension.options.dataOpUserId = opUserId
        thisExtension.options.dataOpUserNickname = opUserNickname
        return false
      }
    }
  },
  // @ts-ignore
  onSelectionUpdate (p) {
    // log the status for debug
    LOG_ENABLED && console.log('selection and input status', p.transaction.selection.from, p.transaction.selection.to, p.editor.view.composing)
  },
  // @ts-ignore
  addProseMirrorPlugins () {
    const extensionThis = this
    return [
      new Plugin({
        key: new PluginKey<any>('composing-check'),
        props: {
          handleDOMEvents: {
            compositionstart: (_event) => {
              LOG_ENABLED && console.log('start chinese input')
              // start and update will fire same time
              isStartChineseInput = true
            },
            compositionupdate: (_event) => {
              LOG_ENABLED && console.log('chinese input continue')
              composingStatus = IME_STATUS_CONTINUE
            }
          }
        },
        appendTransaction(transactions, oldState, newState) {
          // Process track changes logic here
          const editor = extensionThis.editor
          if (!editor) return null

          const thisExtension = getSelfExt(editor)
          const trackChangeEnabled = thisExtension.options.enabled

          // Filter to only process actual content changes
          const relevantTransactions = transactions.filter(tr => {
            if (!tr.docChanged) return false
            if (tr.getMeta('trackManualChanged')) return false
            if (tr.getMeta('history$')) return false
            const syncMeta = tr.getMeta('y-sync$')
            if (syncMeta && syncMeta.isChangeOrigin) return false
            return tr.steps.length > 0
          })

          if (relevantTransactions.length === 0) return null

          // Create a new transaction to append our changes
          const tr = newState.tr
          let modified = false

          relevantTransactions.forEach(transaction => {
            transaction.steps.forEach((step: Step, index: number) => {
              if (step instanceof ReplaceStep) {
                // Handle insertions
                if (step.slice.size > 0) {
                  const insertionMark = newState.schema.marks.insertion.create({
                    'data-op-user-id': thisExtension.options.dataOpUserId,
                    'data-op-user-nickname': thisExtension.options.dataOpUserNickname,
                    'data-op-date': getMinuteTime()
                  })
                  const deletionMark = newState.schema.marks.deletion.create()
                  const from = step.from
                  const to = step.from + step.slice.size

                  if (trackChangeEnabled) {
                    tr.addMark(from, to, insertionMark)
                    modified = true
                  } else {
                    tr.removeMark(from, to, insertionMark.type)
                    modified = true
                  }
                  tr.removeMark(from, to, deletionMark.type)
                  modified = true
                }

                // Handle deletions - re-add with deletion mark
                if (step.from !== step.to && trackChangeEnabled) {
                  const invertedStep = step.invert(transaction.docs[index])
                  if (invertedStep.slice.size > 0) {
                    const deletionMark = newState.schema.marks.deletion.create({
                      'data-op-user-id': thisExtension.options.dataOpUserId,
                      'data-op-user-nickname': thisExtension.options.dataOpUserNickname,
                      'data-op-date': getMinuteTime()
                    })

                    // Re-insert deleted content
                    tr.insert(invertedStep.from, invertedStep.slice.content)
                    tr.addMark(invertedStep.from, invertedStep.from + invertedStep.slice.size, deletionMark)
                    modified = true
                  }
                }
              }
            })
          })

          if (modified) {
            tr.setMeta('trackManualChanged', true)
            return tr
          }
          return null
        }
      })
    ]
  },
  // @ts-ignore
  onSelectionUpdate () {
    // Reset IME status
    composingStatus = IME_STATUS_NORMAL
    isStartChineseInput = false
  }
})

export default TrackChangeExtension
