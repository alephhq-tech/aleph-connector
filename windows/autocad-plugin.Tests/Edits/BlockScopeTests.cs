using System;
using System.Collections.Generic;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.Edits;
using Xunit;

namespace CadAI.AutoCAD.Tests.Edits
{
    public class BlockScopeTests
    {
        [Fact]
        public void ScopeOf_InstanceTransform_ReturnsInstanceOnly()
        {
            var impact = new BlockImpact("DOOR", "10A", 3, new[] { "1", "2", "3" }, false, false);

            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("transform", impact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("update", impact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("erase", impact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("move", impact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("rotate", impact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("scale", impact));
        }

        [Fact]
        public void ScopeOf_SetExplodable_ReturnsSharedDefinition()
        {
            var multiImpact = new BlockImpact("DOOR", "10A", 3, new[] { "1", "2", "3" }, false, false);
            var singleImpact = new BlockImpact("CHAIR", "10B", 1, new[] { "4" }, false, false);

            Assert.Equal(WriteScope.SharedDefinition, BlockScope.ScopeOf("setExplodable", multiImpact));
            Assert.Equal(WriteScope.SharedDefinition, BlockScope.ScopeOf("setExplodable", singleImpact));
        }

        [Fact]
        public void ScopeOf_ExplodeMultiReference_ReturnsSharedDefinition()
        {
            var multiImpact = new BlockImpact("DOOR", "10A", 3, new[] { "1", "2", "3" }, false, false);

            Assert.Equal(WriteScope.SharedDefinition, BlockScope.ScopeOf("explode", multiImpact));
        }

        [Fact]
        public void ScopeOf_ExplodeSingleReference_ReturnsInstanceOnly()
        {
            var singleImpact = new BlockImpact("DESK", "10C", 1, new[] { "5" }, false, false);

            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf("explode", singleImpact));
        }

        [Fact]
        public void ScopeOf_AnonymousOrDynamicBlock_ReturnsUnknown()
        {
            var dynamicImpact = new BlockImpact("*U1", "10D", 2, new[] { "6", "7" }, true, false);

            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("transform", dynamicImpact));
            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("explode", dynamicImpact));
            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("setExplodable", dynamicImpact));
        }

        [Fact]
        public void ScopeOf_XrefBlock_ReturnsUnknown()
        {
            var xrefImpact = new BlockImpact("XREF_ARCH", "10E", 1, new[] { "8" }, false, true);

            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("transform", xrefImpact));
            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("explode", xrefImpact));
            Assert.Equal(WriteScope.Unknown, BlockScope.ScopeOf("setExplodable", xrefImpact));
        }

        [Fact]
        public void ScopeOf_EntityOperationDto_DelegatesCorrectly()
        {
            var multiImpact = new BlockImpact("DOOR", "10A", 3, new[] { "1", "2", "3" }, false, false);
            var opExplode = new EntityOperationDto { Op = "explode" };
            var opTransform = new EntityOperationDto { Op = "transform" };

            Assert.Equal(WriteScope.SharedDefinition, BlockScope.ScopeOf(opExplode, multiImpact));
            Assert.Equal(WriteScope.InstanceOnly, BlockScope.ScopeOf(opTransform, multiImpact));
        }
    }
}
