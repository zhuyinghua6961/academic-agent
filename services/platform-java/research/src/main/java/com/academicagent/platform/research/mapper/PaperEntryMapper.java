package com.academicagent.platform.research.mapper;

import java.util.List;

import com.academicagent.platform.research.entity.PaperEntry;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface PaperEntryMapper extends BaseMapper<PaperEntry> {

    default List<PaperEntry> findByThreadIdAndUserIdOrderByCreatedAtAsc(String threadId, String userId) {
        return selectList(Wrappers.<PaperEntry>lambdaQuery()
                .eq(PaperEntry::getThreadId, threadId)
                .eq(PaperEntry::getUserId, userId)
                .orderByAsc(PaperEntry::getCreatedAt));
    }
}
