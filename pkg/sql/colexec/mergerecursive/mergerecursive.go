// Copyright 2021 Matrix Origin
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package mergerecursive

import (
	"bytes"
	"github.com/matrixorigin/matrixone/pkg/container/batch"
	"github.com/matrixorigin/matrixone/pkg/container/types"
	"github.com/matrixorigin/matrixone/pkg/container/vector"
	"github.com/matrixorigin/matrixone/pkg/vm/process"
)

func String(_ any, buf *bytes.Buffer) {
	buf.WriteString(" merge recursive ")
}

func Prepare(proc *process.Process, arg any) error {
	ap := arg.(*Argument)
	ap.ctr = new(container)
	ap.ctr.InitReceiver(proc, true)
	return nil
}

func Call(idx int, proc *process.Process, arg any, isFirst bool, isLast bool) (bool, error) {
	anal := proc.GetAnalyze(idx)
	anal.Start()
	defer anal.Stop()
	ap := arg.(*Argument)
	ctr := ap.ctr
	var sb *batch.Batch

	if ctr.status == 0 {
		bat, end, err := ctr.ReceiveFromSingleReg(0, anal)
		if err != nil {
			return false, err
		}
		if end || bat == nil {
			ctr.status = 1
		} else {
			sb = bat
		}
	}

	if ctr.status == 1 {
		ctr.status = 2
		sb = specialBatch(proc)
	}

	bat, end, err := ctr.ReceiveFromSingleRegNonBlock(1, anal)
	if err != nil {
		return false, err
	}
	if end {
		proc.SetInputBatch(nil)
		return true, nil
	}
	if bat != nil {
		ctr.bats = append(ctr.bats, bat)
	}

	if sb == nil && len(ctr.bats) > 0 {
		sb = ctr.bats[0]
		ctr.bats = ctr.bats[1:]
	} else if sb == nil {
		sb, _, err = ctr.ReceiveFromSingleReg(1, anal)
		if err != nil {
			return false, err
		}
		if sb == nil {
			proc.SetInputBatch(nil)
			return true, nil
		}
	}

	if sb.SpecialCTE == 2 {
		proc.SetInputBatch(nil)
		return true, nil
	}

	anal.Input(sb, isFirst)
	anal.Output(sb, isLast)
	proc.SetInputBatch(sb)
	return false, nil
}

func specialBatch(proc *process.Process) *batch.Batch {
	resBat := batch.NewWithSize(1)
	resBat.Attrs = []string{
		"some_column",
	}
	resBat.SetVector(0, vector.NewVec(types.T_text.ToType()))
	vector.AppendBytes(resBat.GetVector(0), []byte("hello world"), false, proc.GetMPool())
	resBat.SetZs(1, proc.GetMPool())
	resBat.SpecialCTE = 1
	return resBat
}
