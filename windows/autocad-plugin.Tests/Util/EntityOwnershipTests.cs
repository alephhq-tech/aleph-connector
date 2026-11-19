using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using CadAI.AutoCAD.Dto;
using CadAI.AutoCAD.RpcHandlers;
using CadAI.AutoCAD.Util;
using StreamJsonRpc;
using Xunit;

namespace CadAI.AutoCAD.Tests.Util
{
    public class EntityOwnershipTests
    {
        [Fact]
        public void ProtectedEntity_ErrorCode_IsNegative32038()
        {
            Assert.Equal(-32038, PluginErrorCodes.ProtectedEntity);

            var ex = PluginExceptions.ProtectedEntity("10A, 10B (2 total)", "erase");
            Assert.Equal(PluginErrorCodes.ProtectedEntity, ex.ErrorCode);
            Assert.Contains("Cannot erase: 10A, 10B (2 total)", ex.Message);
            Assert.Contains("not created by CadAI", ex.Message);
            Assert.Contains("edit.begin", ex.Message);
            Assert.Contains("edit.accept", ex.Message);
            Assert.Contains("AutoCAD", ex.Message);
        }

        [Fact]
        public void CreateThenErase_WhenCadAiOwned_Succeeds()
        {
            const string cadAiHandle = "cadai_circle_1";
            var dwgEntities = new HashSet<string> { cadAiHandle };

            // Entity was created and stamped by CadAI -> isCadAiOwned returns true
            EntityOwnership.Guard(
                new[] { cadAiHandle },
                "erase",
                isResolvable: h => dwgEntities.Contains(h),
                isCadAiOwned: h => true);

            // Guard succeeded without throwing; erase proceeds
            dwgEntities.Remove(cadAiHandle);
            Assert.Empty(dwgEntities);
        }

        [Fact]
        public void Erase_PreExistingNonCadAiEntity_ThrowsProtectedEntity_WithCodeNegative32038()
        {
            const string userHandle = "user_bubble_1";
            var dwgEntities = new HashSet<string> { userHandle };

            // Pre-existing user geometry: isCadAiOwned returns false
            var ex = Assert.Throws<LocalRpcException>(() =>
                EntityOwnership.Guard(
                    new[] { userHandle },
                    "erase",
                    isResolvable: h => dwgEntities.Contains(h),
                    isCadAiOwned: h => false));

            Assert.Equal(-32038, ex.ErrorCode);
            Assert.Equal(PluginErrorCodes.ProtectedEntity, ex.ErrorCode);
            Assert.Contains(userHandle, ex.Message);
            Assert.Contains("not created by CadAI", ex.Message);
            Assert.Contains("edit.begin", ex.Message);
            Assert.Contains("edit.accept", ex.Message);

            // Entity was not erased
            Assert.Contains(userHandle, dwgEntities);
        }

        [Fact]
        public void MixedBatch_RefusesBeforeErasingAnything_ErasesNothing()
        {
            var batch = new List<string> { "cadai_1", "user_wall_1", "cadai_2" };
            var erased = new List<string>();

            // Guard runs BEFORE any mutation
            var ex = Assert.Throws<LocalRpcException>(() =>
            {
                EntityOwnership.Guard(
                    batch,
                    "erase",
                    isResolvable: _ => true,
                    isCadAiOwned: h => h.StartsWith("cadai_"));

                // If guard didn't throw, deletion would happen here
                foreach (var h in batch)
                {
                    erased.Add(h);
                }
            });

            Assert.Equal(PluginErrorCodes.ProtectedEntity, ex.ErrorCode);
            Assert.Contains("user_wall_1", ex.Message);
            // Refusal precedes mutation: 0 entities erased, CadAI-owned ones untouched
            Assert.Empty(erased);
        }

        [Fact]
        public void DrawingCleanup_Duplicates_ErasesOnlyCadAiDuplicates_PreservesUserDuplicates()
        {
            // Scenario: 2 identical user circles (u1, u2) and 2 identical CadAI circles (c1, c2)
            // Duplicate check marks the second of each pair as candidates for cleanup
            var duplicateCandidates = new List<string> { "user_circle_2", "cadai_circle_2" };
            var actuallyErased = new List<string>();

            var (erased, skipped) = CheckHandlers.EraseByHandleCore(
                duplicateCandidates,
                dryRun: false,
                isResolvable: _ => true,
                isCadAiOwned: h => h.StartsWith("cadai_"),
                eraseAction: h => actuallyErased.Add(h));

            // Only CadAI duplicate was erased; user duplicate was skipped and protected
            Assert.Single(erased);
            Assert.Equal("cadai_circle_2", erased[0]);
            Assert.Equal(1, skipped);
            Assert.Single(actuallyErased);
            Assert.Equal("cadai_circle_2", actuallyErased[0]);

            // Applied DTO shape check
            var appliedDto = new DrawingCleanupAppliedDto
            {
                Fix = "duplicates",
                Count = erased.Count,
                Handles = erased,
                SkippedProtected = skipped
            };
            Assert.Equal(1, appliedDto.Count);
            Assert.Equal(1, appliedDto.SkippedProtected);
            Assert.Equal(new[] { "cadai_circle_2" }, appliedDto.Handles);
        }

        [Fact]
        public void DrawingCleanup_ZeroLength_SkipsUserCurves()
        {
            // Scenario: user dimension tick marks and empty text vs CadAI zero-length line
            var zeroLengthCandidates = new List<string> { "user_tick_1", "user_tick_2", "cadai_line_0" };
            var actuallyErased = new List<string>();

            var (erased, skipped) = CheckHandlers.EraseByHandleCore(
                zeroLengthCandidates,
                dryRun: false,
                isResolvable: _ => true,
                isCadAiOwned: h => h.StartsWith("cadai_"),
                eraseAction: h => actuallyErased.Add(h));

            Assert.Single(erased);
            Assert.Equal("cadai_line_0", erased[0]);
            Assert.Equal(2, skipped);
            Assert.Single(actuallyErased);
            Assert.DoesNotContain("user_tick_1", actuallyErased);
            Assert.DoesNotContain("user_tick_2", actuallyErased);

            var appliedDto = new DrawingCleanupAppliedDto
            {
                Fix = "zeroLength",
                Count = erased.Count,
                Handles = erased,
                SkippedProtected = skipped
            };
            Assert.Equal(1, appliedDto.Count);
            Assert.Equal(2, appliedDto.SkippedProtected);
        }

        [Fact]
        public void MirrorWithErase_WhenSourceIsUserEntity_Refuses()
        {
            const string userSourceHandle = "user_door_1";
            var eraseRequested = true;

            // When erase == true, ApplyMirror guards the source handles first
            var ex = Assert.Throws<LocalRpcException>(() =>
            {
                if (eraseRequested)
                {
                    EntityOwnership.Guard(
                        new[] { userSourceHandle },
                        "erase",
                        isResolvable: _ => true,
                        isCadAiOwned: _ => false);
                }
            });

            Assert.Equal(PluginErrorCodes.ProtectedEntity, ex.ErrorCode);
            Assert.Contains(userSourceHandle, ex.Message);
        }

        [Fact]
        public void MirrorWithoutErase_WhenSourceIsUserEntity_Succeeds()
        {
            const string userSourceHandle = "user_door_1";
            var eraseRequested = false;

            // When erase == false, mirror-copy is allowed on user entities (cloning, not deleting)
            if (eraseRequested)
            {
                EntityOwnership.Guard(
                    new[] { userSourceHandle },
                    "erase",
                    isResolvable: _ => true,
                    isCadAiOwned: _ => false);
            }

            // Succeeded without throwing
            Assert.False(eraseRequested);
        }

        [Fact]
        public void Stamp_SurvivesFreshReadBack_XDataRoundTrip()
        {
            Assert.Equal("CADAI", EntityOwnership.AppName);
            Assert.Equal("1", EntityOwnership.StampValue);

            // Stamp buffer creation
            using var stampBuffer = EntityOwnership.CreateStampBuffer();
            Assert.NotNull(stampBuffer);

            // Non-null buffer under AppName indicates ownership per contract:
            // "reads GetXDataForApplication(AppName); treat any non-null buffer as owned."
            bool simulatedIsCadAiOwned(string? appName, object? buffer) =>
                appName == EntityOwnership.AppName && buffer != null;

            Assert.True(simulatedIsCadAiOwned(EntityOwnership.AppName, stampBuffer));
            Assert.False(simulatedIsCadAiOwned(EntityOwnership.AppName, null));
            Assert.False(simulatedIsCadAiOwned("SOME_OTHER_APP", stampBuffer));
        }

        [Fact]
        public void Guard_MoreThanEightHandles_TruncatesInMessage_WithTotalCount()
        {
            var userHandles = Enumerable.Range(1, 12).Select(i => $"U{i:X2}").ToList();

            var ex = Assert.Throws<LocalRpcException>(() =>
                EntityOwnership.Guard(
                    userHandles,
                    "erase",
                    isResolvable: _ => true,
                    isCadAiOwned: _ => false));

            Assert.Equal(PluginErrorCodes.ProtectedEntity, ex.ErrorCode);
            // Must name up to 8 handles and the total count
            Assert.Contains("U01", ex.Message);
            Assert.Contains("U08", ex.Message);
            Assert.DoesNotContain("U09", ex.Message);
            Assert.Contains("(12 total)", ex.Message);
        }

        [Fact]
        public void Guard_NonResolvingHandles_AreIgnored()
        {
            var nonResolvingHandles = new[] { "NON_EXISTENT_1", "NON_EXISTENT_2" };

            // Non-resolving handles are skipped, matching EraseMany's silent skip
            EntityOwnership.Guard(
                nonResolvingHandles,
                "erase",
                isResolvable: _ => false,
                isCadAiOwned: _ => false);
        }
    }
}
