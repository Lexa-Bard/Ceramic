import { CID } from 'multiformats/cid'

import type { MerkleTree } from '../merkle/merkle-tree.js'
import { pathString, TreeMetadata } from '../merkle/merkle.js'

import type { Config } from 'node-config-ts'

import { logEvent, logger } from '../logger/index.js'
import { Utils } from '../utils.js'
import { Anchor } from '../models/anchor.js'
import { Request, REQUEST_MESSAGES, RequestStatus, RequestStatus as RS } from '../models/request.js'
import type { Transaction } from '../models/transaction.js'
import type { RequestRepository } from '../repositories/request-repository.js'
import type { TransactionRepository } from '../repositories/transaction-repository.js'

import type { IIpfsService } from './ipfs-service.type.js'
import type { EventProducerService } from './event-producer/event-producer-service.js'
import type { CeramicService } from './ceramic-service.js'
import {
  ServiceMetrics as Metrics,
  SinceField,
  TimeableMetric,
} from '@ceramicnetwork/observability'
import { METRIC_NAMES } from '../settings.js'
import { BlockchainService } from './blockchain/blockchain-service.js'
import { CommitID, StreamID } from '@ceramicnetwork/streamid'

import {
  BloomMetadata,
  Candidate,
  CIDHolder,
  IpfsLeafCompare,
  IpfsMerge,
} from '../merkle/merkle-objects.js'
import { v4 as uuidv4 } from 'uuid'
import type { Knex } from 'knex'
import type { IAnchorRepository } from '../repositories/anchor-repository.type.js'
import { MerkleTreeFactory } from '../merkle/merkle-tree-factory.js'
import type { IMetadataRepository } from '../repositories/metadata-repository.js'

const CONTRACT_TX_TYPE = 'f(bytes32)'

type RequestGroups = {
  alreadyAnchoredRequests: Request[]
  conflictingRequests: Request[]
  failedRequests: Request[]
  unprocessedRequests: Request[]
  acceptedRequests: Request[]
}

type AnchorSummary = {
  acceptedRequestsCount: number
  alreadyAnchoredRequestsCount: number
  anchoredRequestsCount: number
  conflictingRequestCount: number
  failedRequestsCount: number
  failedToPublishAnchorCommitCount: number
  unprocessedRequestCount: number
  candidateCount: number
  anchorCount: number
  canRetryCount: number
}

const logAnchorSummary = async (
  requestRepository: RequestRepository,
  groupedRequests: RequestGroups,
  candidates: Candidate[],
  results: Partial<AnchorSummary> = {}
) => {
  const pendingRequestsCount = await requestRepository.countByStatus(RequestStatus.PENDING)

  const anchorSummary: AnchorSummary = Object.assign(
    {
      acceptedRequestsCount: groupedRequests.acceptedRequests.length,
      alreadyAnchoredRequestsCount: groupedRequests.alreadyAnchoredRequests.length,
      anchoredRequestsCount: 0,
      conflictingRequestCount: groupedRequests.conflictingRequests.length,
      failedRequestsCount: groupedRequests.failedRequests.length,
      failedToPublishAnchorCommitCount: 0,
      unprocessedRequestCount: groupedRequests.unprocessedRequests.length,
      pendingRequestsCount,
      candidateCount: candidates.length,
      anchorCount: 0,
      canRetryCount:
        groupedRequests.failedRequests.length - groupedRequests.conflictingRequests.length,
    },
    results
  )

  Metrics.recordObjectFields('anchorBatch', anchorSummary)
  Metrics.recordRatio(
    'anchorBatch_failureRatio',
    anchorSummary.failedRequestsCount,
    anchorSummary.anchoredRequestsCount
  )

  logEvent.anchor({
    type: 'anchorRequests',
    ...anchorSummary,
  })
}
/**
 * Anchors CIDs to blockchain
 */
export class AnchorService {
  private readonly merkleDepthLimit: number
  private readonly useSmartContractAnchors: boolean
  private readonly maxStreamLimit: number
  private readonly minStreamLimit: number
  private readonly merkleTreeFactory: MerkleTreeFactory<CIDHolder, Candidate, TreeMetadata>

  static inject = [
    'blockchainService',
    'config',
    'ipfsService',
    'requestRepository',
    'transactionRepository',
    'ceramicService',
    'anchorRepository',
    'dbConnection',
    'eventProducerService',
    'metadataRepository',
  ] as const

  constructor(
    private readonly blockchainService: BlockchainService,
    config: Config,
    private readonly ipfsService: IIpfsService,
    private readonly requestRepository: RequestRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly ceramicService: CeramicService,
    private readonly anchorRepository: IAnchorRepository,
    private readonly connection: Knex,
    private readonly eventProducerService: EventProducerService,
    private readonly metadataRepository: IMetadataRepository
  ) {
    this.merkleDepthLimit = config.merkleDepthLimit
    this.useSmartContractAnchors = config.useSmartContractAnchors

    this.maxStreamLimit = this.merkleDepthLimit > 0 ? Math.pow(2, this.merkleDepthLimit) : 0
    this.minStreamLimit = config.minStreamCount || Math.floor(this.maxStreamLimit / 2)

    const ipfsMerge = new IpfsMerge(this.ipfsService)
    const ipfsCompare = new IpfsLeafCompare()
    const bloomMetadata = new BloomMetadata()
    this.merkleTreeFactory = new MerkleTreeFactory(
      ipfsMerge,
      ipfsCompare,
      bloomMetadata,
      this.merkleDepthLimit
    )
  }

  /**
   * Creates anchors for pending client requests
   */
  // TODO: Remove for CAS V2 as we won't need to move PENDING requests to ready. Switch to using anchorReadyRequests.
  async anchorRequests(): Promise<void> {
    // FIXME PREV
    // const readyRequestsCount = await this.requestRepository.countByStatus(RS.READY)
    //
    // if (readyRequestsCount === 0) {
    //   // Pull in twice as many streams as we want to anchor, since some of those streams may fail to load.
    //   await this.requestRepository.findAndMarkReady(this.maxStreamLimit * 2, this.minStreamLimit)
    // }

    return this.anchorReadyRequests()
  }

  /**
   * Creates anchors for client requests that have been marked as READY
   */
  async anchorReadyRequests(): Promise<void> {
    // TODO: Remove this after restart loop removed as part of switching to go-ipfs
    // Skip sleep for unit tests
    if (process.env.NODE_ENV != 'test') {
      logger.imp('sleeping one minute for ipfs to stabilize')
      await Utils.delay(1000 * 60)
    }

    logger.imp('Anchoring ready requests...')
    logger.debug(`Loading requests from the database`)
    // FIXME PREV
    // const requests: Request[] = await this.requestRepository.findAndMarkAsProcessing()
    const requests = await this.requestRepository.batchProcessing(
      this.minStreamLimit,
      this.maxStreamLimit
    )
    await this._anchorRequests(requests)

    // Sleep 5 seconds before exiting the process to give time for the logs to flush.
    await Utils.delay(5000)
  }

  async garbageCollectPinnedStreams(): Promise<void> {
    const requests: Request[] = await this.requestRepository.findRequestsToGarbageCollect()
    await this._garbageCollect(requests)
  }

  private async _anchorRequests(requests: Request[]): Promise<void> {
    if (requests.length === 0) {
      logger.debug('No pending CID requests found. Skipping anchor.')
      return
    }

    let streamCountLimit = 0 // 0 means no limit
    if (this.merkleDepthLimit > 0) {
      // The number of streams we are able to include in a single anchor batch is limited by the
      // max depth of the merkle tree.
      streamCountLimit = Math.pow(2, this.merkleDepthLimit)
    }
    const [candidates, groupedRequests] = await this._findCandidates(requests, streamCountLimit)

    if (candidates.length === 0) {
      logger.imp('No candidates found. Skipping anchor.')
      await logAnchorSummary(this.requestRepository, groupedRequests, candidates)
      return
    }

    try {
      const results = await this._anchorCandidates(candidates)
      await logAnchorSummary(this.requestRepository, groupedRequests, candidates, results)
      return
    } catch (err) {
      logger.warn(
        `Updating PROCESSING requests to PENDING so they are retried in the next batch because an error occured while creating the anchors: ${err}`
      )
      const acceptedRequests = candidates.map((candidate) => candidate.acceptedRequests).flat()
      await this.requestRepository.updateRequests({ status: RS.PENDING }, acceptedRequests)

      Metrics.count(METRIC_NAMES.REVERT_TO_PENDING, acceptedRequests.length)

      // groupRequests.failedRequests does not include all the newly failed requests so we recount here
      const failedRequests = candidates.map((candidate) => candidate.failedRequests).flat()
      await logAnchorSummary(this.requestRepository, groupedRequests, candidates, {
        failedRequestsCount: failedRequests.length,
        // NOTE: We will retry all of the above requests that were updated back to PENDING.
        // We also may retry all failed requests other than requests rejected from conflict resolution.
        // A failed request will not be retried if it has expired when the next anchor runs.
        canRetryCount:
          failedRequests.length -
          groupedRequests.conflictingRequests.length +
          acceptedRequests.length,
      })

      throw err
    }
  }

  private async _anchorCandidates(candidates: Candidate[]): Promise<Partial<AnchorSummary>> {
    logger.imp(`Creating Merkle tree from ${candidates.length} selected streams`)
    const span = Metrics.startSpan('anchor_candidates')
    const merkleTree = await this._buildMerkleTree(candidates)

    // create and send ETH transaction
    const tx: Transaction = await this.transactionRepository.withTransactionMutex(() => {
      logger.debug('Preparing to send transaction to put merkle root on blockchain')
      return this.blockchainService.sendTransaction(merkleTree.root.data.cid)
    })

    // create proof on IPFS
    logger.debug('Creating IPFS anchor proof')
    const ipfsProofCid = await this._createIPFSProof(tx, merkleTree.root.data.cid)

    // create anchor records on IPFS
    logger.debug('Creating anchor commits')
    const anchors = await this._createAnchorCommits(ipfsProofCid, merkleTree)

    // Update the database to record the successful anchors
    logger.debug('Persisting results to local database')
    const numAnchoredRequests = await this._persistAnchorResult(anchors, candidates)

    logger.imp(`Service successfully anchored ${anchors.length} CIDs.`)
    Metrics.count(METRIC_NAMES.ANCHOR_SUCCESS, anchors.length)

    span.end()

    return {
      anchoredRequestsCount: numAnchoredRequests,
      failedToPublishAnchorCommitCount: merkleTree.leafNodes.length - anchors.length,
      anchorCount: anchors.length,
    }
  }

  private async _garbageCollect(requests: Request[]): Promise<void> {
    const streamIds = new Set<string>()
    requests.forEach((request) => streamIds.add(request.streamId))

    logger.imp(
      `Garbage collecting ${streamIds.size} pinned Streams from ${requests.length} Requests`
    )

    const unpinnedStreams = new Set<string>()
    for (const streamIdStr of streamIds) {
      try {
        const streamId = StreamID.fromString(streamIdStr)
        await this.ceramicService.unpinStream(streamId)
        unpinnedStreams.add(streamIdStr)
        logger.debug(`Stream ${streamIdStr.toString()} successfully unpinned`)
      } catch (err) {
        logger.err(`Error unpinning Stream ${streamIdStr}: ${err}`)
      }
    }

    logger.imp(`Successfully unpinned ${unpinnedStreams.size} Streams`)

    const garbageCollectedRequests = requests.filter((request) =>
      unpinnedStreams.has(request.streamId)
    )

    await this.requestRepository.updateRequests({ pinned: false }, garbageCollectedRequests)

    logger.imp(`Successfully garbage collected ${garbageCollectedRequests.length} Requests`)
  }

  /**
   * Emits an anchor event if
   * 1. There are existing ready requests that have timed out (have not been picked up and set to
   * PROCESSING by an anchor worker in a reasonable amount of time)
   * 2. There are requests that have been successfully marked as READY
   * An anchor event indicates that a batch of requests are ready to be anchored. An anchor worker will retrieve these READY requests,
   * mark them as PROCESSING, and perform an anchor.
   */
  async emitAnchorEventIfReady(): Promise<void> {
    const readyRequestsCount = await this.requestRepository.countByStatus(RS.READY)

    if (readyRequestsCount > 0) {
      // if ready requests have been updated because they have expired
      // we will retry them by emitting an anchor event and not marking anymore requests as READY
      const updatedExpiredReadyRequestsCount =
        await this.requestRepository.updateExpiringReadyRequests()

      if (updatedExpiredReadyRequestsCount === 0) {
        return
      }

      logger.debug(
        `Emitting an anchor event beacuse ${updatedExpiredReadyRequestsCount} READY requests expired`
      )
      Metrics.count(METRIC_NAMES.RETRY_EMIT_ANCHOR_EVENT, updatedExpiredReadyRequestsCount)
    } else {
      const updatedRequests = await this.requestRepository.findAndMarkReady(
        this.maxStreamLimit,
        this.minStreamLimit
      )

      if (updatedRequests.length === 0) {
        return
      }
    }

    await this.eventProducerService.emitAnchorEvent(uuidv4().toString()).catch((err) => {
      // We do not crash when we cannot emit an anchor event
      // An event will emit the next time this is run and the ready requests have expired (in READY_TIMEOUT)
      logger.err(`Error when emitting an anchor event: ${err}`)
    })
  }

  /**
   * Builds merkle tree
   * @param candidates
   * @private
   */
  async _buildMerkleTree(
    candidates: Candidate[]
  ): Promise<MerkleTree<CIDHolder, Candidate, TreeMetadata>> {
    try {
      return await this.merkleTreeFactory.build(candidates)
    } catch (e) {
      console.error(e)
      throw new Error('Merkle tree cannot be created: ' + e.toString())
    }
  }

  /**
   * Creates a proof record for the entire merkle tree that was anchored in the given
   * ethereum transaction, publishes that record to IPFS, and returns the CID.
   * @param tx - ETH transaction
   * @param merkleRootCid - CID of the root of the merkle tree that was anchored in 'tx'
   */
  async _createIPFSProof(tx: Transaction, merkleRootCid: CID): Promise<CID> {
    const txHashCid = Utils.convertEthHashToCid(tx.txHash.slice(2))
    const ipfsAnchorProof = {
      blockNumber: tx.blockNumber,
      blockTimestamp: tx.blockTimestamp,
      root: merkleRootCid,
      chainId: tx.chain,
      txHash: txHashCid,
    } as any

    if (this.useSmartContractAnchors) ipfsAnchorProof.txType = CONTRACT_TX_TYPE

    logger.debug('Anchor proof: ' + JSON.stringify(ipfsAnchorProof))
    const ipfsProofCid = await this.ipfsService.storeRecord(ipfsAnchorProof)
    logger.debug('Anchor proof cid: ' + ipfsProofCid.toString())
    return ipfsProofCid
  }

  /**
   * For each CID that was anchored, create a Ceramic AnchorCommit and publish it to IPFS.
   * @param ipfsProofCid - CID of the anchor proof on IPFS
   * @param merkleTree - Merkle tree instance
   * @returns An array of Anchor objects that can be persisted in the database with the result
   * of each anchor request.
   * @private
   */
  async _createAnchorCommits(
    ipfsProofCid: CID,
    merkleTree: MerkleTree<CIDHolder, Candidate, TreeMetadata>
  ): Promise<Anchor[]> {
    const leafNodes = merkleTree.leafNodes
    const anchors = []

    for (let i = 0; i < leafNodes.length; i++) {
      const candidate = leafNodes[i].data
      logger.debug(
        `Creating anchor commit #${i + 1} of ${
          leafNodes.length
        }: stream id ${candidate.streamId.toString()} at commit CID ${candidate.cid}`
      )
      const anchor = await this._createAnchorCommit(candidate, i, ipfsProofCid, merkleTree)
      if (anchor) {
        anchors.push(anchor)
      }
    }

    return anchors
  }

  /**
   * Helper function for _createAnchorCommits that creates a single anchor commit for a single candidate.
   * @param candidate
   * @param candidateIndex - index of the candidate within the leaves of the merkle tree.
   * @param ipfsProofCid
   * @param merkleTree
   */
  async _createAnchorCommit(
    candidate: Candidate,
    candidateIndex: number,
    ipfsProofCid: CID,
    merkleTree: MerkleTree<CIDHolder, Candidate, TreeMetadata>
  ): Promise<Anchor | null> {
    const anchor: Anchor = new Anchor()
    anchor.requestId = candidate.newestAcceptedRequest.id
    anchor.proofCid = ipfsProofCid.toString()

    const path = merkleTree.getDirectPathFromRoot(candidateIndex)
    anchor.path = pathString(path)

    const ipfsAnchorCommit = {
      id: candidate.streamId.cid,
      prev: candidate.cid,
      proof: ipfsProofCid,
      path: anchor.path,
    }

    try {
      const anchorCid = await this.ipfsService.publishAnchorCommit(
        ipfsAnchorCommit,
        candidate.streamId
      )
      anchor.cid = anchorCid.toString()

      logger.debug(
        `Created anchor commit with CID ${anchorCid.toString()} for stream ${candidate.streamId.toString()}`
      )
    } catch (err) {
      const msg = `Error publishing anchor commit of commit ${
        candidate.cid
      } for stream ${candidate.streamId.toString()}: ${err}`
      logger.err(msg)
      Metrics.count(METRIC_NAMES.ERROR_IPFS, 1)
      await this.requestRepository.updateRequests(
        { status: RS.FAILED, message: msg },
        candidate.acceptedRequests
      )
      candidate.failAllRequests()
      return null
    }
    return anchor
  }

  /**
   * Updates the anchor and request repositories in the local database with the results
   * of the anchor
   * @param anchors - Anchor objects to be persisted
   * @param candidates - Candidate objects for the Streams that had anchor attempts. Note that some
   *   of them may have encountered failures during the anchor attempt.
   * @returns The number of successfully anchored requests
   * @private
   */
  async _persistAnchorResult(anchors: Anchor[], candidates: Candidate[]): Promise<number> {
    // filter to requests for streams that were actually anchored successfully
    const acceptedRequests = []
    for (const candidate of candidates) {
      acceptedRequests.push(...candidate.acceptedRequests)
    }

    const trx = await this.connection.transaction(null, { isolationLevel: 'repeatable read' })
    try {
      if (anchors.length > 0) {
        await this.anchorRepository.createAnchors(anchors, { connection: trx })
      }

      await this.requestRepository.withConnection(trx).updateRequests(
        {
          status: RS.COMPLETED,
          message: 'CID successfully anchored.',
          pinned: true,
        },
        acceptedRequests
      )

      await trx.commit()
    } catch (err) {
      await trx.rollback()
      throw err
    }
    const completed = new TimeableMetric(SinceField.CREATED_AT)
    completed.recordAll(acceptedRequests)

    Metrics.count(METRIC_NAMES.ACCEPTED_REQUESTS, acceptedRequests.length)
    return acceptedRequests.length
  }

  /**
   * After loading Candidate streams, we are left with several groups of requests that for various
   * reasons will not be included in this batch.  This function takes those requests and updates
   * the database for them as needed.
   * @param requests
   */
  async _updateNonSelectedRequests(requests: RequestGroups) {
    const { alreadyAnchoredRequests, conflictingRequests, failedRequests, unprocessedRequests } =
      requests

    if (failedRequests.length > 0) {
      logger.debug(
        `About to fail ${failedRequests.length} requests for CIDs that could not be loaded`
      )
      Metrics.count(METRIC_NAMES.FAILED_REQUESTS, failedRequests.length)
      await this.requestRepository.updateRequests(
        {
          status: RS.FAILED,
          message: 'Request has failed. Commit could not be loaded',
        },
        failedRequests
      )
    }

    if (conflictingRequests.length > 0) {
      logger.debug(
        `About to fail ${conflictingRequests.length} requests rejected by conflict resolution`
      )
      for (const rejected of conflictingRequests) {
        logger.warn(
          `Rejecting request to anchor CID ${rejected.cid.toString()} for stream ${
            rejected.streamId
          } because it was rejected by Ceramic's conflict resolution rules`
        )
      }
      Metrics.count(METRIC_NAMES.CONFLICTING_REQUESTS, conflictingRequests.length)
      await this.requestRepository.updateRequests(
        {
          status: RS.FAILED,
          message: REQUEST_MESSAGES.conflictResolutionRejection,
        },
        conflictingRequests
      )
    }

    if (alreadyAnchoredRequests.length > 0) {
      logger.debug(
        `Marking ${alreadyAnchoredRequests.length} requests for CIDs that have already been anchored as COMPLETED`
      )
      Metrics.count(METRIC_NAMES.ALREADY_ANCHORED_REQUESTS, alreadyAnchoredRequests.length)
      await this.requestRepository.updateRequests(
        {
          status: RS.COMPLETED,
          message: 'Request was already anchored',
          pinned: true,
        },
        alreadyAnchoredRequests
      )
    }

    if (unprocessedRequests.length > 0) {
      logger.debug(
        `There were ${unprocessedRequests.length} unprocessed requests that didn't make it into this batch.  Marking them as PENDING.`
      )
      Metrics.count(METRIC_NAMES.UNPROCESSED_REQUESTS, unprocessedRequests.length)

      await this.requestRepository.updateRequests(
        {
          status: RS.PENDING,
          message: '',
          pinned: true,
        },
        unprocessedRequests
      )
    }
  }

  /**
   * Find candidates for the anchoring. Also updates the Request database for the Requests that we
   * already know at this point have failed, already been anchored, or were excluded from processing
   * in this batch.
   * @private
   */
  async _findCandidates(
    requests: Request[],
    candidateLimit: number
  ): Promise<[Candidate[], RequestGroups]> {
    logger.debug(`Grouping requests by stream`)
    const candidates = await this._buildCandidates(requests)

    logger.debug(`Loading candidate streams`)
    // FIXME PREV
    const groupedRequests = await this._loadCandidateStreams(candidates, candidateLimit)
    // await this._updateNonSelectedRequests(groupedRequests)

    // FIXME PREV
    // const candidatesToAnchor = candidates.filter((candidate) => {
    //   return candidate.shouldAnchor()
    // })
    const candidatesToAnchor = candidates

    if (candidatesToAnchor.length > 0) {
      for (const candidate of candidates) {
        groupedRequests.acceptedRequests.push(...candidate.acceptedRequests)
      }
    }

    return [candidatesToAnchor, groupedRequests]
  }

  /**
   * Groups requests on the same StreamID into single Candidate objects.
   * @param requests
   */
  async _buildCandidates(requests: Request[]): Promise<Array<Candidate>> {
    // FIXME PREV We do not need to do conflict resolution here. We do conflict resolution by time when a request gets submitted.
    // const requestsByStream: Map<string, Request[]> = new Map()
    //
    // for (const request of requests) {
    //   let streamRequests = requestsByStream.get(request.streamId)
    //   if (!streamRequests) {
    //     streamRequests = []
    //     requestsByStream.set(request.streamId, streamRequests)
    //   }
    //
    //   streamRequests.push(request)
    // }
    //
    // const candidates = Array.from(requestsByStream).map(([streamId, requests]) => {
    //   return new Candidate(StreamID.fromString(streamId), requests)
    // })
    const candidates = requests.map((r) => new Candidate(StreamID.fromString(r.streamId), [r]))
    for (const candidate of candidates) {
      const metadata = await this.metadataRepository.retrieve(candidate.streamId) // TODO Move to service, make it throw when not found
      candidate.setMetadata(metadata.metadata)
    }
    // Make sure we process candidate streams in order of their earliest request.
    candidates.sort((candidate0, candidate1) => {
      return Math.sign(
        candidate0.earliestRequestDate.getTime() - candidate1.earliestRequestDate.getTime()
      )
    })
    return candidates
  }

  /**
   * Loads the streams corresponding to each Candidate and updates the internal bookkeeping within
   * each Candidate object to keep track of what the right CID to anchor for each Stream is. Also
   * returns information about the Requests that we already know at this point have failed, already
   * been anchored, or were excluded from processing in this batch.
   *
   * @param candidates
   * @param candidateLimit - limit on the number of candidate streams that can be returned.
   * @private
   */
  async _loadCandidateStreams(
    candidates: Candidate[],
    candidateLimit: number
  ): Promise<RequestGroups> {
    const failedRequests: Request[] = []
    const conflictingRequests: Request[] = []
    const unprocessedRequests: Request[] = []
    const alreadyAnchoredRequests: Request[] = []

    let numSelectedCandidates = 0
    if (candidateLimit == 0 || candidates.length < candidateLimit) {
      candidateLimit = candidates.length
    }

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]

      if (numSelectedCandidates >= candidateLimit) {
        // No need to process this candidate, we've already filled our anchor batch
        unprocessedRequests.push(...candidate.requests)
        continue
      }

      // FIXME PREV Do not need to load from Ceramic
      // await AnchorService._loadCandidate(candidate, this.ceramicService)

      // anchor commit may already exist so check first
      const existingAnchorCommit = candidate.shouldAnchor()
        ? await this.anchorRepository.findByRequest(candidate.newestAcceptedRequest)
        : null

      if (existingAnchorCommit) {
        candidate.markAsAnchored()
      }

      if (candidate.shouldAnchor()) {
        numSelectedCandidates++
        logger.debug(
          `Selected candidate stream #${numSelectedCandidates} of ${candidateLimit}: streamid ${candidate.streamId} at commit cid ${candidate.cid}`
        )
      } else if (candidate.alreadyAnchored) {
        logger.debug(`Stream ${candidate.streamId.toString()} is already anchored`)
        alreadyAnchoredRequests.push(...candidate.acceptedRequests)
      }
      failedRequests.push(...candidate.failedRequests)
      conflictingRequests.push(...candidate.rejectedRequests)
    }

    return {
      alreadyAnchoredRequests,
      acceptedRequests: [],
      conflictingRequests,
      failedRequests,
      unprocessedRequests,
    }
  }

  /**
   * Uses a multiQuery to load the current version of the Candidate Stream, while simultaneously
   * providing the Ceramic node the CommitIDs for each pending Request on this Stream. This ensures
   * that the Ceramic node we are using has at least heard of and considered every commit that
   * has a pending anchor request, even if it hadn't heard of that tip via pubsub. We can then
   * use the guaranteed current version of the Stream to decide what CID to anchor.
   * @param candidate
   * @param ceramicService
   * @private
   */
  static async _loadCandidate(candidate: Candidate, ceramicService: CeramicService): Promise<void> {
    // First, load the current known stream state from the ceramic node
    let stream
    try {
      stream = await ceramicService.loadStream(candidate.streamId)
    } catch (err) {
      logger.err(`Failed to load stream ${candidate.streamId.toString()}: ${err}`)
      candidate.failAllRequests()
      return
    }

    // Now filter out requests from the Candidate that are already present in the stream log
    const missingRequests = candidate.requests.filter((req) => {
      const found = stream.state.log.find(({ cid }) => {
        return cid.toString() == req.cid
      })
      return !found
    })

    // If stream already knows about all CIDs that we have requests for, great!
    if (missingRequests.length == 0) {
      candidate.setTipToAnchor(stream)
      return
    }

    for (const req of missingRequests) {
      logger.debug(
        `Stream ${req.streamId} is missing Commit CID ${req.cid}. Sending multiquery to force ceramic to load it`
      )
    }

    // If there were CIDs that we have requests for but didn't show up in the stream state that
    // we loaded from Ceramic, we can't tell if that is because those commits were rejected by
    // Ceramic's conflict resolution, or if our local Ceramic node just never heard about those
    // commits before.  So we build a multiquery including all missing commits and send that to
    // Ceramic, forcing it to at least consider every CID that we have a request for.
    const queries = missingRequests.map((request) => {
      return { streamId: CommitID.make(candidate.streamId, request.cid).toString() }
    })
    queries.push({ streamId: candidate.streamId.baseID.toString() })

    // Send multiquery
    let response
    try {
      response = await ceramicService.multiQuery(queries)
    } catch (err) {
      logger.err(
        `Multiquery failed for stream ${candidate.streamId.toString()} with ${
          missingRequests.length
        } missing commits: ${err}`
      )
      Metrics.count(METRIC_NAMES.ERROR_MULTIQUERY, 1)
      candidate.failAllRequests()
      return
    }

    // Fail requests for tips that failed to be loaded
    for (const request of missingRequests) {
      const commitId = CommitID.make(candidate.streamId, request.cid)
      if (!response[commitId.toString()]) {
        logger.err(
          `Failed to load stream ${commitId.baseID.toString()} at commit ${commitId.commit.toString()}`
        )
        Metrics.count(METRIC_NAMES.FAILED_TIP, 1)
        candidate.failRequest(request)
      }
    }
    if (candidate.allRequestsFailed()) {
      // If all pending requests for this stream failed to load then don't anchor the stream.
      logger.warn(
        `All pending request CIDs for stream ${candidate.streamId.toString()} failed to load - skipping stream`
      )
      return
    }

    // Get the current version of the Stream that has considered all pending request CIDs and select
    // tip to anchor
    stream = response[candidate.streamId.toString()]
    if (!stream) {
      logger.err(`Failed to load stream ${candidate.streamId.toString()}`)
      Metrics.count(METRIC_NAMES.FAILED_STREAM, 1)
      candidate.failAllRequests()
      return
    }
    candidate.setTipToAnchor(stream)
  }
}
