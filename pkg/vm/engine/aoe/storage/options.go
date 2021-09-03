package engine

import (
	"matrixone/pkg/vm/engine/aoe/storage/common"
	e "matrixone/pkg/vm/engine/aoe/storage/event"
	"matrixone/pkg/vm/engine/aoe/storage/gc"
	"matrixone/pkg/vm/engine/aoe/storage/gc/gci"
	md "matrixone/pkg/vm/engine/aoe/storage/metadata/v1"
	"matrixone/pkg/vm/engine/aoe/storage/sched"
	"sync"
	"time"
)

const (
	DefaultIndexCacheSize = 128 * common.M
	DefaultMTCacheSize    = 4 * common.G
	DefaultSSTCacheSize   = 4 * common.G

	DefaultBlockMaxRows     = uint64(40000)
	DefaultBlocksPerSegment = uint64(40)

	DefaultCleanInterval = 5

	DefaultBlockWriters     = uint16(8)
	DefaultSegmentWriters   = uint16(4)
	DefaultStatelessWorkers = uint16(1)
)

type IterOptions struct {
	TableName  string
	TableID    uint64
	All        bool
	ColIdxes   []int
	SegmentIds []uint64
}

type CacheCfg struct {
	IndexCapacity  uint64 `toml:"index-cache-size"`
	InsertCapacity uint64 `toml:"insert-cache-size"`
	DataCapacity   uint64 `toml:"data-cache-size"`
}

type MetaCfg struct {
	BlockMaxRows     uint64 `toml:"block-max-rows"`
	SegmentMaxBlocks uint64 `toml:"segment-max-blocks"`
}

type SchedulerCfg struct {
	BlockWriters     uint16 `toml:"block-writers"`
	SegmentWriters   uint16 `toml:"segment-writers"`
	StatelessWorkers uint16 `toml:"stateless-workers"`
}

type MetaCleanerCfg struct {
	Interval time.Duration
}

type Options struct {
	EventListener e.EventListener

	Mu sync.RWMutex

	Scheduler    sched.Scheduler
	SchedulerCfg *SchedulerCfg `toml:"scheduler-cfg"`

	Meta struct {
		CKFactory *checkpointerFactory
		Conf      *MetaCfg
		Info      *md.MetaInfo
	}

	GC struct {
		Conf     *gci.WorkerCfg
		Acceptor gci.IAcceptor
	}

	CacheCfg *CacheCfg `toml:"cache-cfg"`

	MetaCleanerCfg *MetaCleanerCfg
}

func (o *Options) FillDefaults(dirname string) *Options {
	if o == nil {
		o = &Options{}
	}
	o.EventListener.FillDefaults()

	if o.SchedulerCfg == nil {
		o.SchedulerCfg = &SchedulerCfg{
			BlockWriters:     DefaultBlockWriters,
			SegmentWriters:   DefaultSegmentWriters,
			StatelessWorkers: DefaultStatelessWorkers,
		}
	} else {
		if o.SchedulerCfg.BlockWriters == 0 {
			o.SchedulerCfg.BlockWriters = DefaultBlockWriters
		}
		if o.SchedulerCfg.SegmentWriters == 0 {
			o.SchedulerCfg.SegmentWriters = DefaultSegmentWriters
		}
		if o.SchedulerCfg.StatelessWorkers == 0 {
			o.SchedulerCfg.StatelessWorkers = DefaultStatelessWorkers
		}
	}

	if o.Meta.Info == nil {
		metaCfg := &md.Configuration{
			Dir: dirname,
		}
		if o.Meta.Conf == nil {
			metaCfg.BlockMaxRows = DefaultBlockMaxRows
			metaCfg.SegmentMaxBlocks = DefaultBlocksPerSegment
		} else {
			metaCfg.BlockMaxRows = o.Meta.Conf.BlockMaxRows
			metaCfg.SegmentMaxBlocks = o.Meta.Conf.SegmentMaxBlocks
		}
		o.Meta.Info = md.NewMetaInfo(&o.Mu, metaCfg)
	}

	if o.Meta.CKFactory == nil {
		o.Meta.CKFactory = NewCheckpointerFactory(dirname)
	}

	if o.CacheCfg == nil {
		o.CacheCfg = &CacheCfg{
			IndexCapacity:  DefaultIndexCacheSize,
			InsertCapacity: DefaultMTCacheSize,
			DataCapacity:   DefaultSSTCacheSize,
		}
	}

	if o.GC.Acceptor == nil {
		cfg := o.GC.Conf
		if cfg == nil {
			cfg = new(gci.WorkerCfg)
			cfg.Interval = gci.DefaultInterval
		}
		o.GC.Acceptor = gc.NewWorker(cfg)
	}

	if o.MetaCleanerCfg == nil {
		o.MetaCleanerCfg = &MetaCleanerCfg{
			Interval: time.Duration(DefaultCleanInterval) * time.Second,
		}
	}
	return o
}
